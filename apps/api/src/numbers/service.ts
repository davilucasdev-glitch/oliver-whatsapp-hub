import type { NumberRole, PhoneNumber, QualityRating } from '@prisma/client';
import type { Deps } from '../deps.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { encrypt } from '../lib/crypto.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { startOfDayInTz, startOfMonthInTz } from '../lib/time.js';
import { sendTemplateMessage, sendTextMessage } from '../messaging/outbound.js';
import { isServiceWindowOpen } from '../messaging/window.js';
import { MetaCloudProvider } from '../whatsapp/meta-cloud-provider.js';
import { MetaManagementClient } from '../whatsapp/meta-management.js';
import { WhatsAppApiError, type PhoneNumberInfo } from '../whatsapp/provider.js';
import { decideQualityPolicy, mapMetaQuality, tierToDailyLimit } from './quality.js';

const log = childLogger('numbers');

export function managementClient(deps: Deps): MetaManagementClient {
  return new MetaManagementClient({
    accessToken: deps.env.META_ACCESS_TOKEN,
    baseUrl: deps.env.META_GRAPH_BASE_URL,
    apiVersion: deps.env.META_GRAPH_VERSION,
  });
}

/** Nunca devolve o token ao painel — só se o número tem token próprio. */
export function toPublicNumber(n: PhoneNumber) {
  const { accessTokenEnc, ...rest } = n;
  return { ...rest, hasOwnToken: Boolean(accessTokenEnc) };
}

export async function listNumbersWithStats(deps: Deps) {
  const now = new Date();
  const tz = deps.env.TZ_BUSINESS;
  const [numbers, today, month, active, unreadAlerts] = await Promise.all([
    deps.db.phoneNumber.findMany({ orderBy: { createdAt: 'asc' } }),
    deps.db.message.groupBy({
      by: ['phoneNumberId'],
      where: { direction: 'OUTBOUND', createdAt: { gte: startOfDayInTz(now, tz) }, status: { not: 'FAILED' } },
      _count: { _all: true },
    }),
    deps.db.message.groupBy({
      by: ['phoneNumberId'],
      where: { direction: 'OUTBOUND', createdAt: { gte: startOfMonthInTz(now, tz) }, status: { not: 'FAILED' } },
      _count: { _all: true },
    }),
    deps.db.campaign.groupBy({
      by: ['phoneNumberId'],
      where: { status: { in: ['RUNNING', 'SCHEDULED', 'PAUSED'] } },
      _count: { _all: true },
    }),
    deps.db.alert.groupBy({ by: ['phoneNumberId'], where: { readAt: null }, _count: { _all: true } }),
  ]);
  const count = (rows: { phoneNumberId: string | null; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.phoneNumberId === id)?._count._all ?? 0;

  return numbers.map((n) => ({
    ...toPublicNumber(n),
    stats: {
      sentToday: count(today, n.id),
      sentMonth: count(month, n.id),
      activeCampaigns: count(active, n.id),
      unreadAlerts: count(unreadAlerts, n.id),
    },
  }));
}

async function fetchInfo(deps: Deps, phoneNumberId: string, accessToken: string): Promise<PhoneNumberInfo> {
  const provider = new MetaCloudProvider({
    phoneNumberId,
    accessToken,
    baseUrl: deps.env.META_GRAPH_BASE_URL,
    apiVersion: deps.env.META_GRAPH_VERSION,
  });
  try {
    return await provider.getPhoneNumberInfo();
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      throw badRequest(`A Meta recusou os dados deste número: ${err.message}`);
    }
    throw err;
  }
}

export interface CreateNumberInput {
  phoneNumberId: string;
  wabaId: string;
  displayName?: string;
  accessToken?: string;
  role: NumberRole;
  baseSendRatePerMinute?: number;
}

export async function createNumber(deps: Deps, input: CreateNumberInput) {
  const exists = await deps.db.phoneNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId } });
  if (exists) throw new HttpError(409, 'Este phone_number_id já está cadastrado.');
  const token = input.accessToken || deps.env.META_ACCESS_TOKEN;
  if (!token) throw badRequest('Informe o token do número ou configure META_ACCESS_TOKEN no .env.');

  // Valida na Meta antes de salvar (token e phone_number_id corretos).
  const info = await fetchInfo(deps, input.phoneNumberId, token);
  const rating = mapMetaQuality(info.qualityRating);
  const base = input.baseSendRatePerMinute ?? 20;
  const policy = decideQualityPolicy(rating, base, input.displayName ?? info.verifiedName ?? input.phoneNumberId);
  const limit = tierToDailyLimit(info.messagingLimitTier);

  const created = await deps.db.phoneNumber.create({
    data: {
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayName: input.displayName || info.verifiedName || input.phoneNumberId,
      displayPhone: info.displayPhoneNumber ? `+${info.displayPhoneNumber.replace(/\D/g, '')}` : null,
      accessTokenEnc: input.accessToken ? encrypt(input.accessToken, deps.env.ENCRYPTION_KEY) : null,
      role: input.role,
      status: info.status ?? 'CONNECTED',
      qualityRating: rating,
      messagingTier: info.messagingLimitTier,
      ...(limit ? { dailyConversationLimit: limit } : {}),
      baseSendRatePerMinute: base,
      sendRatePerMinute: policy.sendRatePerMinute,
      campaignsPaused: policy.campaignsPaused,
      lastSyncedAt: new Date(),
    },
  });
  log.info({ number: created.displayName }, 'Número cadastrado');
  return toPublicNumber(created);
}

export interface UpdateNumberInput {
  displayName?: string;
  role?: NumberRole;
  botEnabled?: boolean;
  isActive?: boolean;
  baseSendRatePerMinute?: number;
  accessToken?: string | null; // null = remover token próprio (usa o do .env)
}

export async function updateNumber(deps: Deps, id: string, input: UpdateNumberInput) {
  const n = await deps.db.phoneNumber.findUnique({ where: { id } });
  if (!n) throw notFound('Número não encontrado');
  if (input.accessToken) await fetchInfo(deps, n.phoneNumberId, input.accessToken); // valida o token novo

  let rate: number | undefined;
  if (input.baseSendRatePerMinute !== undefined) {
    rate = decideQualityPolicy(n.qualityRating, input.baseSendRatePerMinute, n.displayName).sendRatePerMinute;
  }
  const updated = await deps.db.phoneNumber.update({
    where: { id },
    data: {
      displayName: input.displayName,
      role: input.role,
      botEnabled: input.botEnabled,
      isActive: input.isActive,
      baseSendRatePerMinute: input.baseSendRatePerMinute,
      sendRatePerMinute: rate,
      ...(input.accessToken === null ? { accessTokenEnc: null } : {}),
      ...(input.accessToken ? { accessTokenEnc: encrypt(input.accessToken, deps.env.ENCRYPTION_KEY) } : {}),
    },
  });
  return toPublicNumber(updated);
}

/** Retomar campanhas depois de uma pausa automática (bloqueado se a qualidade ainda está BAIXA). */
export async function resumeCampaigns(deps: Deps, id: string) {
  const n = await deps.db.phoneNumber.findUnique({ where: { id } });
  if (!n) throw notFound('Número não encontrado');
  if (n.qualityRating === 'LOW') {
    throw new HttpError(409, 'A qualidade deste número ainda está BAIXA. Aguarde a recuperação antes de retomar as campanhas.');
  }
  return toPublicNumber(await deps.db.phoneNumber.update({ where: { id }, data: { campaignsPaused: false } }));
}

/** Aplica a política anti-bloqueio (ritmo/pausa/alerta) para um número. */
export async function applyQuality(deps: Deps, number: PhoneNumber, rating: QualityRating, tier?: string) {
  const decision = decideQualityPolicy(rating, number.baseSendRatePerMinute, number.displayName, number.qualityRating);
  const limit = tierToDailyLimit(tier);
  const updated = await deps.db.phoneNumber.update({
    where: { id: number.id },
    data: {
      qualityRating: rating,
      sendRatePerMinute: decision.sendRatePerMinute,
      // pausa automática em BAIXA; retomada é sempre manual pelo painel
      campaignsPaused: decision.campaignsPaused || number.campaignsPaused,
      ...(tier ? { messagingTier: tier } : {}),
      ...(limit ? { dailyConversationLimit: limit } : {}),
      lastSyncedAt: new Date(),
    },
  });
  if (decision.campaignsPaused) {
    await deps.db.campaign.updateMany({
      where: { phoneNumberId: number.id, status: { in: ['RUNNING', 'SCHEDULED'] } },
      data: { status: 'PAUSED', pausedReason: 'Qualidade do número BAIXA' },
    });
  }
  if (decision.alert) {
    await deps.db.alert.create({ data: { ...decision.alert, phoneNumberId: number.id } });
  }
  log.info({ number: number.displayName, rating, tier }, 'Qualidade do número atualizada');
  return updated;
}

/** Busca status, nome, qualidade e tier atuais na Meta. */
export async function syncNumber(deps: Deps, id: string) {
  const n = await deps.db.phoneNumber.findUnique({ where: { id } });
  if (!n) throw notFound('Número não encontrado');
  let info: PhoneNumberInfo;
  try {
    info = await deps.providers(n).getPhoneNumberInfo();
  } catch (err) {
    await deps.db.phoneNumber.update({ where: { id }, data: { status: 'ERROR', lastSyncedAt: new Date() } });
    throw badRequest(`Não foi possível consultar a Meta: ${(err as Error).message}`);
  }
  await deps.db.phoneNumber.update({
    where: { id },
    data: {
      status: info.status ?? n.status,
      displayPhone: info.displayPhoneNumber ? `+${info.displayPhoneNumber.replace(/\D/g, '')}` : n.displayPhone,
    },
  });
  const fresh = await deps.db.phoneNumber.findUniqueOrThrow({ where: { id } });
  return toPublicNumber(await applyQuality(deps, fresh, mapMetaQuality(info.qualityRating), info.messagingLimitTier));
}

/** Importa da WABA os números que ainda não estão cadastrados. */
export async function importNumbersFromWaba(deps: Deps, wabaId: string) {
  if (!wabaId) throw badRequest('Informe o WABA ID (ou configure META_WABA_ID no .env).');
  let list;
  try {
    list = await managementClient(deps).listPhoneNumbers(wabaId);
  } catch (err) {
    throw badRequest(`Não foi possível listar os números da WABA: ${(err as Error).message}`);
  }
  const created: string[] = [];
  for (const p of list) {
    const exists = await deps.db.phoneNumber.findUnique({ where: { phoneNumberId: p.id } });
    if (exists) continue;
    const rating = mapMetaQuality(p.quality_rating);
    const limit = tierToDailyLimit(p.messaging_limit_tier);
    await deps.db.phoneNumber.create({
      data: {
        phoneNumberId: p.id,
        wabaId,
        displayName: p.verified_name || p.display_phone_number,
        displayPhone: `+${p.display_phone_number.replace(/\D/g, '')}`,
        status: p.status ?? 'CONNECTED',
        qualityRating: rating,
        messagingTier: p.messaging_limit_tier,
        ...(limit ? { dailyConversationLimit: limit } : {}),
        sendRatePerMinute: decideQualityPolicy(rating, 20, p.verified_name).sendRatePerMinute,
        campaignsPaused: rating === 'LOW',
        lastSyncedAt: new Date(),
      },
    });
    created.push(p.display_phone_number);
  }
  return { found: list.length, created };
}

/**
 * "Testar envio" para um número seu. Se você escreveu para a empresa nas últimas 24h, vai texto;
 * senão vai o template de teste (padrão hello_world), único tipo permitido fora da janela.
 */
export async function sendTestMessage(deps: Deps, id: string, toRaw: string) {
  const n = await deps.db.phoneNumber.findUnique({ where: { id } });
  if (!n) throw notFound('Número não encontrado');
  const to = normalizePhone(toRaw);
  if (!to) throw badRequest('Telefone inválido. Use DDD + número, ex.: (11) 98888-7777.');

  const contact = await deps.db.contact.upsert({ where: { phone: to }, create: { phone: to }, update: {} });
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: n.id } },
    create: { contactId: contact.id, phoneNumberId: n.id },
    update: {},
  });
  try {
    if (isServiceWindowOpen(conv.lastInboundAt)) {
      const msg = await sendTextMessage(deps, {
        conversationId: conv.id,
        sentBy: 'HUMAN',
        body: `✅ Teste de envio do Oliver WhatsApp Hub pelo número ${n.displayName}.`,
      });
      return { mode: 'text' as const, messageId: msg.id, waMessageId: msg.waMessageId };
    }
    const msg = await sendTemplateMessage(deps, {
      conversationId: conv.id,
      sentBy: 'HUMAN',
      name: deps.env.TEST_TEMPLATE_NAME,
      language: deps.env.TEST_TEMPLATE_LANGUAGE,
      renderedBody: `[template ${deps.env.TEST_TEMPLATE_NAME}]`,
    });
    return { mode: 'template' as const, template: deps.env.TEST_TEMPLATE_NAME, messageId: msg.id, waMessageId: msg.waMessageId };
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw badRequest(`A Meta recusou o envio: ${err.message}`);
    throw err;
  }
}
