import { emitSiteEvent } from '../site/webhooks.js';
import { Prisma, type MessageStatus, type PhoneNumber } from '@prisma/client';
import type { ReplyEngine } from '../bot/reply-engine.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { waIdToE164 } from '../lib/phone.js';
import { detectConsentIntent, OPT_IN_CONFIRMATION, OPT_OUT_CONFIRMATION } from '../messaging/opt-out.js';
import { sendTextMessage } from '../messaging/outbound.js';
import { mapMetaQuality } from '../numbers/quality.js';
import { applyQuality } from '../numbers/service.js';
import { getSetting, SETTINGS } from '../settings.js';
import { autoPauseCampaign } from '../campaigns/engine.js';
import { classifyMetaCode } from '../campaigns/errors.js';
import { REPLY_ATTRIBUTION_DAYS } from '../campaigns/rules.js';
import { inboundMedia, inboundText, type ExtractedEvent } from '../webhook/extract.js';
import type { InboundJob } from '../webhook/routes.js';

const log = childLogger('inbound');

const STATUS_RANK: Record<MessageStatus, number> = {
  RECEIVED: 0,
  QUEUED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
};

export function createInboundProcessor(deps: Deps, engine: ReplyEngine) {
  return async function processInbound(job: InboundJob): Promise<void> {
    const row = await deps.db.webhookEvent.findUnique({ where: { id: job.eventId } });
    if (!row) {
      log.warn({ eventId: job.eventId }, 'Evento não encontrado');
      return;
    }
    if (row.processedAt) return; // já processado (retry/duplicata)

    const ev = row.payload as unknown as ExtractedEvent;
    try {
      switch (ev.kind) {
        case 'message':
          await handleMessage(deps, engine, ev);
          break;
        case 'status':
          await handleStatus(deps, ev);
          break;
        case 'quality':
          await handleQuality(deps, ev);
          break;
        case 'template_status':
          await handleTemplateStatus(deps, ev);
          break;
      }
      await deps.db.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), error: null } });
    } catch (err) {
      await deps.db.webhookEvent.update({ where: { id: row.id }, data: { error: (err as Error).message.slice(0, 1000) } });
      throw err;
    }
  };
}

/** Número que recebeu a mensagem; se ainda não foi cadastrado, registra automaticamente. */
async function resolveNumber(deps: Deps, phoneNumberId: string, wabaId: string, displayPhone?: string): Promise<PhoneNumber> {
  const existing = await deps.db.phoneNumber.findUnique({ where: { phoneNumberId } });
  if (existing) return existing;
  log.warn({ phoneNumberId }, 'Mensagem para número não cadastrado — cadastrando automaticamente');
  return deps.db.phoneNumber.upsert({
    where: { phoneNumberId },
    create: {
      phoneNumberId,
      wabaId,
      displayName: displayPhone ? `+${displayPhone}` : phoneNumberId,
      displayPhone: displayPhone ? `+${displayPhone}` : null,
      status: 'CONNECTED',
    },
    update: {},
  });
}

async function handleMessage(deps: Deps, engine: ReplyEngine, ev: Extract<ExtractedEvent, { kind: 'message' }>) {
  const m = ev.message;
  const number = await resolveNumber(deps, ev.phoneNumberId, ev.wabaId, ev.displayPhone);
  const phone = waIdToE164(m.from);
  const receivedAt = new Date(Number(m.timestamp) * 1000 || Date.now());
  const text = inboundText(m);
  const media = inboundMedia(m);

  const contact = await deps.db.contact.upsert({
    where: { phone },
    create: { phone, waId: m.from, name: ev.contactName ?? null, lastInboundAt: receivedAt },
    update: { waId: m.from, lastInboundAt: receivedAt },
  });
  if (!contact.name && ev.contactName) {
    await deps.db.contact.update({ where: { id: contact.id }, data: { name: ev.contactName } });
  }

  const conversation = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: number.id } },
    create: {
      contactId: contact.id,
      phoneNumberId: number.id,
      lastInboundAt: receivedAt,
      lastMessageAt: receivedAt,
      unreadCount: 1,
      awaitingReply: true,
    },
    update: {
      lastInboundAt: receivedAt,
      lastMessageAt: receivedAt,
      unreadCount: { increment: 1 },
      awaitingReply: true,
    },
  });

  let created;
  try {
    created = await deps.db.message.create({
      data: {
        conversationId: conversation.id,
        phoneNumberId: number.id,
        waMessageId: m.id,
        direction: 'INBOUND',
        type: m.type,
        body: text,
        mediaId: media?.id,
        mediaMime: media?.mime,
        payload: m as unknown as Prisma.InputJsonValue,
        status: 'RECEIVED',
        sentBy: 'CONTACT',
        // Ordem = ordem de chegada aqui. O horário da Meta tem precisão de segundos e deixaria a mensagem
        // "antes" de uma resposta enviada no mesmo segundo (a janela de 24h continua usando o horário da Meta).
        createdAt: new Date(Math.max(receivedAt.getTime(), Date.now())),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.debug({ wamid: m.id }, 'Mensagem já registrada');
      return;
    }
    throw err;
  }

  // aviso para o site (atendimento, comprovante, "SAIR"); a mídia fica em GET /api/site/v1/media/:messageId
  await emitSiteEvent(deps, 'message.received', {
    messageId: created.id,
    phone,
    name: contact.name ?? ev.contactName ?? null,
    text: text ?? null,
    type: m.type,
    hasMedia: Boolean(media?.id),
    mediaMime: media?.mime ?? null,
    conversationId: conversation.id,
    receivedAt: receivedAt.toISOString(),
  });

  // Resposta de campanha (até REPLY_ATTRIBUTION_DAYS depois do envio): marca o destinatário como "respondeu".
  const replyCutoff = new Date(Date.now() - REPLY_ATTRIBUTION_DAYS * 86_400_000);
  await deps.db.campaignRecipient.updateMany({
    where: {
      contactId: contact.id,
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      repliedAt: null,
      sentAt: { gte: replyCutoff },
      campaign: { phoneNumberId: number.id },
    },
    data: { status: 'REPLIED', repliedAt: receivedAt },
  });

  // Marca como lida (melhor esforço — não bloqueia o fluxo).
  deps
    .providers(number)
    .markAsRead(m.id)
    .catch((err: Error) => log.warn({ err: err.message }, 'Falha ao marcar como lida'));

  // Opt-out / opt-in por palavra-chave
  const intent = detectConsentIntent(text);
  if (intent === 'OPT_OUT') {
    await deps.db.$transaction([
      deps.db.contact.update({ where: { id: contact.id }, data: { optOut: true, optOutAt: receivedAt } }),
      deps.db.consentLog.create({
        data: { contactId: contact.id, action: 'OPT_OUT', source: 'whatsapp:palavra-chave', detail: text?.slice(0, 200) },
      }),
      deps.db.campaignRecipient.updateMany({
        where: { contactId: contact.id, status: 'PENDING' },
        data: { status: 'OPTED_OUT', skipReason: 'opt-out' },
      }),
      // saiu depois de receber uma campanha recente: entra no relatório de opt-outs dela
      deps.db.campaignRecipient.updateMany({
        where: { contactId: contact.id, sentAt: { gte: replyCutoff }, optedOutAt: null },
        data: { optedOutAt: receivedAt },
      }),
    ]);
    await sendTextMessage(deps, { conversationId: conversation.id, sentBy: 'SYSTEM', body: OPT_OUT_CONFIRMATION });
    await emitSiteEvent(deps, 'contact.opt_out', { phone, name: contact.name ?? null, at: receivedAt.toISOString(), source: 'whatsapp:palavra-chave' });
    log.info({ contactId: contact.id }, 'Contato fez opt-out');
    return;
  }
  if (intent === 'OPT_IN' && contact.optOut) {
    await deps.db.$transaction([
      deps.db.contact.update({
        where: { id: contact.id },
        data: { optOut: false, optOutAt: null, optIn: true, optInAt: receivedAt, optInSource: 'whatsapp:palavra-chave' },
      }),
      deps.db.consentLog.create({
        data: { contactId: contact.id, action: 'OPT_IN', source: 'whatsapp:palavra-chave', detail: text?.slice(0, 200) },
      }),
    ]);
    await sendTextMessage(deps, { conversationId: conversation.id, sentBy: 'SYSTEM', body: OPT_IN_CONFIRMATION });
    return;
  }

  // Quem atende?
  if (conversation.handler === 'HUMAN') return; // humano: só registra
  const botGlobal = await getSetting<boolean>(deps.db, SETTINGS.botEnabled, true);
  if (!botGlobal || !number.botEnabled || number.role === 'CAMPAIGNS') return;
  if (m.type === 'reaction') return;

  await engine.reply(deps, {
    conversationId: conversation.id,
    contactName: contact.name ?? ev.contactName ?? null,
    text,
    messageType: m.type,
    inboundWaMessageId: m.id,
  });
}

async function handleStatus(deps: Deps, ev: Extract<ExtractedEvent, { kind: 'status' }>) {
  const s = ev.status;
  const msg = await deps.db.message.findUnique({ where: { waMessageId: s.id } });
  if (!msg) {
    // Status pode chegar antes de gravarmos o wamid; lança para a fila tentar de novo.
    throw new Error(`Mensagem ${s.id} ainda não registrada para status ${s.status}`);
  }
  const map: Record<string, MessageStatus | undefined> = {
    sent: 'SENT',
    delivered: 'DELIVERED',
    read: 'READ',
    failed: 'FAILED',
  };
  const next = map[s.status];
  if (!next) return;
  const at = new Date(Number(s.timestamp) * 1000 || Date.now());

  const data: Prisma.MessageUpdateInput = {};
  const advances = next === 'FAILED' || STATUS_RANK[next] > STATUS_RANK[msg.status];
  if (next === 'SENT') data.sentAt = at;
  if (next === 'DELIVERED') data.deliveredAt = at;
  if (next === 'READ') data.readAt = at;
  if (next === 'FAILED') {
    data.failedAt = at;
    const e = s.errors?.[0];
    data.errorCode = e ? String(e.code) : null;
    data.errorMessage = (e?.error_data?.details ?? e?.message ?? e?.title ?? null)?.slice(0, 500) ?? null;
  }
  await deps.db.message.update({ where: { id: msg.id }, data });
  // O status só avança, e a condição fica no próprio UPDATE: a Meta manda sent/delivered/read quase
  // juntos e a fila processa em paralelo — um "delivered" atrasado não pode sobrescrever um "read".
  if (advances) {
    const lower = (Object.keys(STATUS_RANK) as MessageStatus[]).filter((st) => STATUS_RANK[st] < STATUS_RANK[next]);
    await deps.db.message.updateMany({ where: { id: msg.id, ...(next === 'FAILED' ? {} : { status: { in: lower } }) }, data: { status: next } });
    data.status = next; // para o aviso ao site abaixo
  }

  if (msg.campaignId) await updateRecipientStatus(deps, s.id, next, at, s.errors?.[0]);

  // status das mensagens que o site pediu (log e relatório do lado do site)
  const siteMsg = await deps.db.siteMessage.findFirst({ where: { messageId: msg.id } });
  if (siteMsg && data.status) {
    await deps.db.siteMessage.update({ where: { id: siteMsg.id }, data: { status: next, error: next === 'FAILED' ? (data.errorMessage as string | null) : siteMsg.error } });
    await emitSiteEvent(deps, 'message.status', {
      messageId: msg.id,
      ref: siteMsg.ref,
      phone: siteMsg.phone,
      status: next.toLowerCase(),
      at: at.toISOString(),
      error: next === 'FAILED' ? { code: data.errorCode ?? null, message: data.errorMessage ?? null } : null,
    });
  }
}

/** Status de entrega → destinatário da campanha (só avança; "respondeu" não volta para "lido"). */
async function updateRecipientStatus(
  deps: Deps,
  wamid: string,
  next: MessageStatus,
  at: Date,
  error?: { code: number; title?: string; message?: string; error_data?: { details?: string } },
) {
  const r = await deps.db.campaignRecipient.findFirst({ where: { waMessageId: wamid }, include: { contact: true } });
  if (!r) return;
  const rank: Partial<Record<string, number>> = { PENDING: 0, SENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, REPLIED: 4 };
  const data: Prisma.CampaignRecipientUpdateInput = {};
  const advance = (to: 'DELIVERED' | 'READ') => {
    if ((rank[r.status] ?? 99) < (rank[to] ?? 0)) data.status = to;
  };
  if (next === 'DELIVERED') {
    data.deliveredAt = r.deliveredAt ?? at;
    advance('DELIVERED');
  } else if (next === 'READ') {
    data.readAt = r.readAt ?? at;
    data.deliveredAt = r.deliveredAt ?? at;
    advance('READ');
  } else if (next === 'FAILED' && r.status !== 'REPLIED') {
    const e = classifyMetaCode(error?.code, 400, error?.error_data?.details ?? error?.message ?? error?.title ?? 'Falha na entrega');
    Object.assign(data, { status: 'FAILED', failedAt: at, errorCode: e.code, errorMessage: e.message });
    if (e.optOut && !r.contact.optOut) {
      await deps.db.$transaction([
        deps.db.contact.update({ where: { id: r.contactId }, data: { optOut: true, optOutAt: at } }),
        deps.db.consentLog.create({ data: { contactId: r.contactId, action: 'OPT_OUT', source: `meta:${e.code}`, detail: e.message } }),
      ]);
    }
    if (e.kind === 'number' || e.kind === 'template') {
      const c = await deps.db.campaign.findUnique({ where: { id: r.campaignId } });
      if (c) await autoPauseCampaign(deps, c, `${e.message} (erro ${e.code})`);
    }
  }
  if (Object.keys(data).length) await deps.db.campaignRecipient.update({ where: { id: r.id }, data });
}

async function handleQuality(deps: Deps, ev: Extract<ExtractedEvent, { kind: 'quality' }>) {
  const v = ev.value;
  const display = v.display_phone_number?.replace(/\D/g, '');
  const numbers = await deps.db.phoneNumber.findMany({ where: { wabaId: ev.wabaId } });
  const number = numbers.find((n) => n.displayPhone?.replace(/\D/g, '') === display) ?? (numbers.length === 1 ? numbers[0] : undefined);
  if (!number) {
    log.warn({ display, wabaId: ev.wabaId }, 'Atualização de qualidade para número não cadastrado');
    return;
  }

  // O evento traz o tier e um "event" (FLAGGED/UNFLAGGED/...). A nota em si vem da API.
  let rating = v.event === 'FLAGGED' ? 'LOW' : v.event === 'UNFLAGGED' ? 'HIGH' : number.qualityRating;
  try {
    const info = await deps.providers(number).getPhoneNumberInfo();
    if (info.qualityRating) rating = mapMetaQuality(info.qualityRating);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Não foi possível consultar a qualidade na Meta; usando o evento');
  }
  await applyQuality(deps, number, mapMetaQuality(rating), v.current_limit);
}

async function handleTemplateStatus(deps: Deps, ev: Extract<ExtractedEvent, { kind: 'template_status' }>) {
  const v = ev.value;
  const name = v.message_template_name;
  const language = v.message_template_language;
  const status = typeof v.event === 'string' ? v.event : undefined;
  if (!name || !status) return;
  const res = await deps.db.template.updateMany({
    where: { wabaId: ev.wabaId, name, ...(language ? { language } : {}) },
    data: { status, rejectedReason: v.reason ?? null, syncedAt: new Date() },
  });
  log.info({ name, status, updated: res.count }, 'Status de template atualizado');

  // Template pausado/desativado/rejeitado pela Meta: campanhas que usam ele param na hora.
  if (status !== 'APPROVED') {
    const campaigns = await deps.db.campaign.findMany({
      where: { status: { in: ['RUNNING', 'SCHEDULED'] }, template: { wabaId: ev.wabaId, name, ...(language ? { language } : {}) } },
    });
    for (const c of campaigns) await autoPauseCampaign(deps, c, `a Meta mudou o template ${name} para ${status}`);
  }
}
