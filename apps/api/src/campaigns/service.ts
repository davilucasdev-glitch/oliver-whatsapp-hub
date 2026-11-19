import type { Campaign, Contact, PhoneNumber, Prisma, Template } from '@prisma/client';
import { z } from 'zod';
import { segmentSchema, segmentWhere, type Segment } from '../contacts/segment.js';
import type { Deps } from '../deps.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { zonedParts, zonedToUtc } from '../lib/time.js';
import { sendTemplateMessage } from '../messaging/outbound.js';
import { getSetting, setSetting, SETTINGS } from '../settings.js';
import { buildSendComponents, renderTemplate, sanitizeParam } from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { WhatsAppApiError, type TemplateComponent } from '../whatsapp/provider.js';
import { dailyCap, estimateDuration, SKIP_LABEL, skipReasonFor, validateWindow } from './rules.js';
import {
  productIdsOf,
  resolveAll,
  resolveVariable,
  templateShape,
  variableMapSchema,
  variableSourceSchema,
  type ProductLookup,
  type VariableMap,
  type VariableSource,
} from './variables.js';

const log = childLogger('campaigns');

export const DEFAULT_MIN_DAYS_BETWEEN = 7;

export async function getMinDaysBetween(deps: Deps): Promise<number> {
  return getSetting<number>(deps.db, SETTINGS.campaignMinDaysBetween, DEFAULT_MIN_DAYS_BETWEEN);
}

export async function setMinDaysBetween(deps: Deps, days: number): Promise<void> {
  await setSetting(deps.db, SETTINGS.campaignMinDaysBetween, days);
}

// ── Entrada do painel ──

const campaignSegmentSchema = segmentSchema.omit({ consent: true });

export const campaignInputSchema = z.object({
  name: z.string().trim().min(2, 'dê um nome à campanha').max(120),
  phoneNumberId: z.string().min(1, 'escolha o número'),
  templateId: z.string().min(1, 'escolha o template'),
  segment: campaignSegmentSchema.default({ tagsAny: [], tagsAll: [], excludeTags: [] }),
  variables: variableMapSchema.default({ header: [], body: [] }),
  headerMediaUrl: z.string().trim().url('link da mídia inválido').nullish(),
  /** data/hora no fuso da empresa, "AAAA-MM-DDTHH:MM" (vazio = sem agendamento) */
  scheduledAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'data/hora inválida')
    .nullish(),
  windowStartHour: z.coerce.number().int().default(9),
  windowEndHour: z.coerce.number().int().default(20),
});

export type CampaignInput = z.infer<typeof campaignInputSchema>;
type CampaignSegment = z.infer<typeof campaignSegmentSchema>;

function parseLocal(value: string, tz: string): Date {
  const [d, t] = value.split('T') as [string, string];
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const [h, min] = t.split(':').map(Number) as [number, number];
  return zonedToUtc(y, m, day, h, min, tz);
}

export function toLocalInput(date: Date | null, tz: string): string | null {
  if (!date) return null;
  const p = zonedParts(date, tz);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

export function segmentOf(c: Pick<Campaign, 'segment'>): Segment {
  return { ...campaignSegmentSchema.parse(c.segment ?? {}), consent: 'any' };
}

export function variablesOf(c: Pick<Campaign, 'variables'>): VariableMap {
  return variableMapSchema.parse(c.variables ?? {});
}

export async function loadProducts(deps: Deps, map: VariableMap): Promise<ProductLookup> {
  const ids = productIdsOf(map);
  if (!ids.length) return new Map();
  const rows = await deps.db.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, price: true, active: true } });
  return new Map(rows.map((p) => [p.id, p]));
}

/** Pode fazer campanha com este número? (mensagem para o painel, ou null) */
export function numberBlockReason(n: Pick<PhoneNumber, 'isActive' | 'role' | 'campaignsPaused' | 'qualityRating' | 'displayName'>): string | null {
  if (!n.isActive) return `O número ${n.displayName} está desativado.`;
  if (n.role === 'ATTENDANCE') return `O número ${n.displayName} é só de atendimento. Mude a função dele em Números para "Campanhas" ou "Ambos".`;
  if (n.qualityRating === 'LOW') return `A qualidade do número ${n.displayName} está BAIXA: campanhas bloqueadas até recuperar.`;
  if (n.campaignsPaused) return `As campanhas do número ${n.displayName} estão pausadas. Libere em Números antes de continuar.`;
  return null;
}

interface Validated {
  number: PhoneNumber;
  template: Template;
  defs: TemplateComponentDef[];
}

/** Confere número, template, variáveis, mídia e janela. Lança 400 com a explicação. */
async function validateInput(
  deps: Deps,
  input: Pick<CampaignInput, 'phoneNumberId' | 'templateId' | 'variables' | 'headerMediaUrl' | 'windowStartHour' | 'windowEndHour'>,
): Promise<Validated> {
  const [number, template] = await Promise.all([
    deps.db.phoneNumber.findUnique({ where: { id: input.phoneNumberId } }),
    deps.db.template.findUnique({ where: { id: input.templateId } }),
  ]);
  if (!number) throw badRequest('Número não encontrado.');
  if (!number.isActive) throw badRequest(`O número ${number.displayName} está desativado.`);
  if (number.role === 'ATTENDANCE') throw badRequest(`O número ${number.displayName} é só de atendimento. Mude a função dele em Números para "Campanhas" ou "Ambos".`);
  if (!template) throw badRequest('Template não encontrado.');
  if (template.wabaId !== number.wabaId) throw badRequest('Este template pertence a outra conta (WABA) e não pode ser usado por este número.');
  if (template.status !== 'APPROVED') throw badRequest(`O template ${template.name} não está aprovado pela Meta (status: ${template.status}).`);

  const defs = template.components as unknown as TemplateComponentDef[];
  const shape = templateShape(defs);
  const vars = input.variables;
  if (vars.header.length !== shape.headerVars) throw badRequest(`O cabeçalho do template tem ${shape.headerVars} variável(is); configure todas.`);
  if (vars.body.length !== shape.bodyVars) throw badRequest(`O texto do template tem ${shape.bodyVars} variável(is); configure todas.`);
  const products = await loadProducts(deps, vars);
  for (const id of productIdsOf(vars)) {
    const p = products.get(id);
    if (!p) throw badRequest('Um produto usado nas variáveis não existe mais no catálogo.');
    if (!p.active) throw badRequest(`O produto "${p.name}" está inativo no Bling.`);
  }
  if (shape.headerMedia) {
    if (!input.headerMediaUrl) throw badRequest(`O template tem cabeçalho de ${MEDIA_LABEL[shape.headerMedia]}: informe o link público do arquivo.`);
    // em desenvolvimento a arte do painel é servida em http://localhost (a Meta simulada não baixa)
    const devLocal = deps.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(input.headerMediaUrl);
    if (!input.headerMediaUrl.startsWith('https://') && !devLocal) throw badRequest('O link da mídia precisa começar com https:// (a Meta baixa o arquivo dele).');
  }
  const w = validateWindow(input.windowStartHour, input.windowEndHour);
  if (w) throw badRequest(w);
  return { number, template, defs };
}

const MEDIA_LABEL = { IMAGE: 'imagem', VIDEO: 'vídeo', DOCUMENT: 'documento' } as const;

/** Componentes de envio + texto renderizado (histórico) para um contato. */
export function buildCampaignMessage(
  defs: TemplateComponentDef[],
  c: Pick<Campaign, 'variables' | 'headerMediaUrl'>,
  contact: Pick<Contact, 'name'>,
  products: ProductLookup,
): { components: TemplateComponent[]; renderedBody: string } {
  const values = resolveAll(variablesOf(c), contact, products);
  const components = buildSendComponents(defs, values);
  const shape = templateShape(defs);
  if (shape.headerMedia) {
    if (!c.headerMediaUrl) throw new Error('Falta o link da mídia do cabeçalho');
    const link = c.headerMediaUrl;
    const param =
      shape.headerMedia === 'IMAGE'
        ? { type: 'image' as const, image: { link } }
        : shape.headerMedia === 'VIDEO'
          ? { type: 'video' as const, video: { link } }
          : { type: 'document' as const, document: { link } };
    components.unshift({ type: 'header', parameters: [param] });
  }
  const text = renderTemplate(defs, { header: values.header.map(sanitizeParam), body: values.body.map(sanitizeParam) });
  return { components, renderedBody: shape.headerMedia ? `[${MEDIA_LABEL[shape.headerMedia]}]\n${text}` : text };
}

// ── CRUD ──

function toData(input: CampaignInput, tz: string): Omit<Prisma.CampaignUncheckedCreateInput, 'status'> {
  return {
    name: input.name,
    phoneNumberId: input.phoneNumberId,
    templateId: input.templateId,
    segment: input.segment as unknown as Prisma.InputJsonValue,
    variables: input.variables as unknown as Prisma.InputJsonValue,
    headerMediaUrl: input.headerMediaUrl || null,
    scheduledAt: input.scheduledAt ? parseLocal(input.scheduledAt, tz) : null,
    timezone: tz,
    windowStartHour: input.windowStartHour,
    windowEndHour: input.windowEndHour,
  };
}

export async function createCampaign(deps: Deps, input: CampaignInput) {
  await validateInput(deps, input);
  return deps.db.campaign.create({ data: { ...toData(input, deps.env.TZ_BUSINESS), status: 'DRAFT' } });
}

export async function updateCampaign(deps: Deps, id: string, input: CampaignInput) {
  const c = await deps.db.campaign.findUnique({ where: { id } });
  if (!c) throw notFound('Campanha não encontrada');
  if (c.status !== 'DRAFT' && c.status !== 'SCHEDULED') throw new HttpError(409, 'Só dá para editar campanhas em rascunho ou agendadas.');
  await validateInput(deps, input);
  const data = toData(input, c.timezone);
  // agendada sem data volta a ser rascunho
  const status = c.status === 'SCHEDULED' && !data.scheduledAt ? 'DRAFT' : c.status;
  return deps.db.campaign.update({ where: { id }, data: { ...data, status } });
}

export async function deleteCampaign(deps: Deps, id: string) {
  const c = await deps.db.campaign.findUnique({ where: { id } });
  if (!c) throw notFound('Campanha não encontrada');
  if (c.status !== 'DRAFT') throw new HttpError(409, 'Só rascunhos podem ser excluídos. Campanhas já iniciadas ficam no histórico (cancele, se precisar).');
  await deps.db.campaign.delete({ where: { id } });
}

export async function duplicateCampaign(deps: Deps, id: string) {
  const c = await deps.db.campaign.findUnique({ where: { id } });
  if (!c) throw notFound('Campanha não encontrada');
  return deps.db.campaign.create({
    data: {
      name: `${c.name} (cópia)`.slice(0, 120),
      phoneNumberId: c.phoneNumberId,
      templateId: c.templateId,
      segment: c.segment as Prisma.InputJsonValue,
      variables: c.variables as Prisma.InputJsonValue,
      headerMediaUrl: c.headerMediaUrl,
      timezone: c.timezone,
      windowStartHour: c.windowStartHour,
      windowEndHour: c.windowEndHour,
      status: 'DRAFT',
    },
  });
}

// ── Público ──

/** Quem do segmento pode receber agora e por que os outros ficam de fora. */
export async function estimateAudience(deps: Deps, segment: CampaignSegment, opts: { phoneNumberId?: string; windowStartHour?: number; windowEndHour?: number } = {}) {
  const now = new Date();
  const minDays = await getMinDaysBetween(deps);
  const base = segmentWhere({ ...segment, consent: 'any' }, now);
  const cutoff = new Date(now.getTime() - minDays * 86_400_000);
  const and = (extra: Prisma.ContactWhereInput): Prisma.ContactWhereInput => ({ AND: [base, extra] });
  const okWhere = and({ optIn: true, optOut: false, ...(minDays > 0 ? { OR: [{ lastCampaignAt: null }, { lastCampaignAt: { lt: cutoff } }] } : {}) });
  const [total, optOut, noOptIn, frequency, sample] = await Promise.all([
    deps.db.contact.count({ where: base }),
    deps.db.contact.count({ where: and({ optOut: true }) }),
    deps.db.contact.count({ where: and({ optOut: false, optIn: false }) }),
    minDays > 0 ? deps.db.contact.count({ where: and({ optOut: false, optIn: true, lastCampaignAt: { gte: cutoff } }) }) : Promise.resolve(0),
    deps.db.contact.findMany({ where: okWhere, take: 5, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, phone: true } }),
  ]);
  const eligible = Math.max(0, total - optOut - noOptIn - frequency);

  let timing = null;
  if (opts.phoneNumberId) {
    const n = await deps.db.phoneNumber.findUnique({ where: { id: opts.phoneNumberId } });
    if (n) {
      const hours = Math.max(1, (opts.windowEndHour ?? 20) - (opts.windowStartHour ?? 9));
      timing = { ratePerMinute: n.sendRatePerMinute, dailyCap: dailyCap(n), windowHours: hours, ...estimateDuration(eligible, n.sendRatePerMinute, hours, dailyCap(n)) };
    }
  }
  return {
    total,
    eligible,
    minDaysBetween: minDays,
    excluded: [
      { reason: 'opt-out', label: SKIP_LABEL['opt-out']!, count: optOut },
      { reason: 'sem opt-in', label: SKIP_LABEL['sem opt-in']!, count: noOptIn },
      { reason: 'frequência', label: `Recebeu campanha nos últimos ${minDays} dias`, count: frequency },
    ],
    sample,
    timing,
  };
}

/** Texto final com os dados de um contato de verdade (ou de exemplo, se o público estiver vazio). */
export async function previewCampaign(
  deps: Deps,
  input: Pick<CampaignInput, 'templateId' | 'headerMediaUrl' | 'segment'> & { contactId?: string; variables: { header: unknown[]; body: unknown[] } },
) {
  const template = await deps.db.template.findUnique({ where: { id: input.templateId } });
  if (!template) throw notFound('Template não encontrado');
  const defs = template.components as unknown as TemplateComponentDef[];
  let contact: Pick<Contact, 'id' | 'name' | 'phone'> | null;
  if (input.contactId) {
    contact = await deps.db.contact.findUnique({ where: { id: input.contactId }, select: { id: true, name: true, phone: true } });
  } else {
    contact = await deps.db.contact.findFirst({
      where: { AND: [segmentWhere({ ...input.segment, consent: 'any' }), { optIn: true, optOut: false }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, phone: true },
    });
  }
  // Variáveis ainda incompletas (texto vazio, produto não escolhido) aparecem como {{n}} na prévia.
  const valid = (list: unknown[]) => list.map((v) => variableSourceSchema.safeParse(v)).map((r) => (r.success ? r.data : null));
  const header = valid(input.variables.header);
  const body = valid(input.variables.body);
  const products = await loadProducts(deps, { header: header.filter((v) => v !== null), body: body.filter((v) => v !== null) });
  const shape = templateShape(defs);
  const who = contact ?? { name: 'Maria Souza' };
  const fill = (list: (VariableSource | null)[], n: number) =>
    Array.from({ length: n }, (_, i) => {
      const v = list[i];
      if (!v) return `{{${i + 1}}}`;
      try {
        return resolveVariable(v, who, products) || `{{${i + 1}}}`;
      } catch {
        return `{{${i + 1}}}`;
      }
    });
  return {
    contact,
    text: renderTemplate(defs, { header: fill(header, shape.headerVars), body: fill(body, shape.bodyVars) }),
    headerMedia: shape.headerMedia ? { format: shape.headerMedia, url: input.headerMediaUrl ?? null } : null,
  };
}

/** "Congela" o público ao iniciar: um destinatário por contato, com o motivo de quem fica de fora. */
export async function buildAudience(deps: Deps, campaign: Campaign, now = new Date()): Promise<number> {
  const minDays = await getMinDaysBetween(deps);
  const where = segmentWhere(segmentOf(campaign), now);
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const page = await deps.db.contact.findMany({
      where,
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, phone: true, optIn: true, optOut: true, lastCampaignAt: true },
    });
    if (!page.length) break;
    const res = await deps.db.campaignRecipient.createMany({
      data: page.map((c) => {
        const skip = skipReasonFor(c, now, minDays);
        return { campaignId: campaign.id, contactId: c.id, status: skip ? ('SKIPPED' as const) : ('PENDING' as const), skipReason: skip };
      }),
      skipDuplicates: true,
    });
    total += res.count;
    cursor = page.at(-1)?.id;
    if (page.length < 1000) break;
  }
  const count = await deps.db.campaignRecipient.count({ where: { campaignId: campaign.id } });
  await deps.db.campaign.update({ where: { id: campaign.id }, data: { totalRecipients: count, audienceBuiltAt: now } });
  log.info({ campaign: campaign.name, total: count, novos: total }, 'Público da campanha montado');
  return count;
}

// ── Ações ──

async function loadForAction(deps: Deps, id: string) {
  const c = await deps.db.campaign.findUnique({ where: { id }, include: { phoneNumber: true, template: true } });
  if (!c) throw notFound('Campanha não encontrada');
  return c;
}

async function assertCanSend(deps: Deps, c: Awaited<ReturnType<typeof loadForAction>>) {
  const block = numberBlockReason(c.phoneNumber);
  if (block) throw new HttpError(409, block);
  await validateInput(deps, { ...c, variables: variablesOf(c) });
}

/** Coloca para rodar agora (monta o público na primeira vez). */
export async function launchCampaign(deps: Deps, id: string, now = new Date()) {
  const c = await deps.db.campaign.findUniqueOrThrow({ where: { id } });
  const res = await deps.db.campaign.updateMany({
    where: { id, status: { in: ['DRAFT', 'SCHEDULED', 'PAUSED'] } },
    data: { status: 'RUNNING', startedAt: c.startedAt ?? now, pausedReason: null, pausedAt: null, waitingReason: null, lastError: null },
  });
  if (!res.count) return false;
  if (!c.audienceBuiltAt) await buildAudience(deps, c, now);
  return true;
}

export async function startCampaign(deps: Deps, id: string) {
  const c = await loadForAction(deps, id);
  if (c.status !== 'DRAFT' && c.status !== 'SCHEDULED') throw new HttpError(409, 'Esta campanha já foi iniciada.');
  await assertCanSend(deps, c);
  const est = await estimateAudience(deps, segmentOf(c));
  if (est.eligible === 0) throw new HttpError(409, 'Nenhum contato do público pode receber esta campanha agora (veja quem ficou de fora na estimativa).');
  const now = new Date();
  if (c.scheduledAt && c.scheduledAt > now) {
    await deps.db.campaign.update({ where: { id }, data: { status: 'SCHEDULED' } });
    log.info({ campaign: c.name, em: c.scheduledAt }, 'Campanha agendada');
  } else {
    await launchCampaign(deps, id, now);
    log.info({ campaign: c.name }, 'Campanha iniciada');
  }
  return deps.db.campaign.findUniqueOrThrow({ where: { id } });
}

export async function unscheduleCampaign(deps: Deps, id: string) {
  const res = await deps.db.campaign.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'DRAFT' } });
  if (!res.count) throw new HttpError(409, 'A campanha não está agendada.');
}

export async function pauseCampaign(deps: Deps, id: string, reason = 'Pausada por você') {
  const res = await deps.db.campaign.updateMany({
    where: { id, status: { in: ['RUNNING', 'SCHEDULED'] } },
    data: { status: 'PAUSED', pausedReason: reason, pausedAt: new Date(), waitingReason: null },
  });
  if (!res.count) throw new HttpError(409, 'A campanha não está em andamento.');
}

export async function resumeCampaign(deps: Deps, id: string) {
  const c = await loadForAction(deps, id);
  if (c.status !== 'PAUSED') throw new HttpError(409, 'A campanha não está pausada.');
  await assertCanSend(deps, c);
  const now = new Date();
  if (!c.audienceBuiltAt && c.scheduledAt && c.scheduledAt > now) {
    await deps.db.campaign.update({ where: { id }, data: { status: 'SCHEDULED', pausedReason: null, pausedAt: null } });
  } else {
    await launchCampaign(deps, id, now);
  }
}

export async function cancelCampaign(deps: Deps, id: string) {
  const now = new Date();
  const res = await deps.db.campaign.updateMany({
    where: { id, status: { in: ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED'] } },
    data: { status: 'CANCELED', finishedAt: now, waitingReason: null },
  });
  if (!res.count) throw new HttpError(409, 'A campanha já terminou.');
  await deps.db.campaignRecipient.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'SKIPPED', skipReason: 'campanha cancelada' } });
}

/** Manda a campanha (com as variáveis resolvidas) para um telefone seu, sem contar no relatório. */
export async function sendCampaignTest(deps: Deps, id: string, phoneRaw: string) {
  const c = await loadForAction(deps, id);
  await validateInput(deps, { ...c, variables: variablesOf(c) });
  const phone = normalizePhone(phoneRaw);
  if (!phone) throw badRequest('Telefone inválido. Use DDD + número, ex.: (11) 98888-7777.');
  const contact = await deps.db.contact.upsert({ where: { phone }, create: { phone }, update: {} });
  if (contact.optOut) throw new HttpError(409, 'Este telefone pediu para não receber campanhas (opt-out).');
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: c.phoneNumberId } },
    create: { contactId: contact.id, phoneNumberId: c.phoneNumberId },
    update: {},
  });
  const products = await loadProducts(deps, variablesOf(c));
  const msg = buildCampaignMessage(c.template.components as unknown as TemplateComponentDef[], c, contact, products);
  try {
    await sendTemplateMessage(deps, { conversationId: conv.id, sentBy: 'HUMAN', name: c.template.name, language: c.template.language, ...msg });
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw badRequest(`A Meta recusou o envio: ${err.message}`);
    throw err;
  }
  return { to: phone, text: msg.renderedBody };
}

// ── Relatório ──

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  optOuts: number;
  skipped: number;
}

export async function campaignCounts(deps: Deps, campaignId: string): Promise<CampaignCounts> {
  const w = (extra: Prisma.CampaignRecipientWhereInput) => deps.db.campaignRecipient.count({ where: { campaignId, ...extra } });
  const [total, pending, sent, delivered, read, replied, failed, optOuts, skipped] = await Promise.all([
    w({}),
    w({ status: { in: ['PENDING', 'SENDING'] } }),
    w({ sentAt: { not: null } }),
    w({ OR: [{ deliveredAt: { not: null } }, { status: { in: ['DELIVERED', 'READ'] } }] }),
    w({ OR: [{ readAt: { not: null } }, { status: 'READ' }] }),
    w({ repliedAt: { not: null } }),
    w({ status: 'FAILED' }),
    w({ optedOutAt: { not: null } }),
    w({ status: { in: ['SKIPPED', 'OPTED_OUT'] } }),
  ]);
  return { total, pending, sent, delivered, read, replied, failed, optOuts, skipped };
}

function publicCampaign(c: Campaign & { phoneNumber: Pick<PhoneNumber, 'id' | 'displayName' | 'displayPhone'>; template: Pick<Template, 'id' | 'name' | 'language' | 'category' | 'status'> }) {
  return { ...c, scheduledLocal: toLocalInput(c.scheduledAt, c.timezone) };
}

const LIST_INCLUDE = {
  phoneNumber: { select: { id: true, displayName: true, displayPhone: true } },
  template: { select: { id: true, name: true, language: true, category: true, status: true } },
} as const;

export async function listCampaigns(deps: Deps) {
  const rows = await deps.db.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: LIST_INCLUDE });
  const ids = rows.map((r) => r.id);
  const [byStatus, sent] = await Promise.all([
    deps.db.campaignRecipient.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
    deps.db.campaignRecipient.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, sentAt: { not: null } }, _count: { _all: true } }),
  ]);
  return rows.map((c) => {
    const st = byStatus.filter((r) => r.campaignId === c.id);
    const n = (...s: string[]) => st.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
    return {
      ...publicCampaign(c),
      counts: {
        total: c.totalRecipients,
        pending: n('PENDING', 'SENDING'),
        sent: sent.find((r) => r.campaignId === c.id)?._count._all ?? 0,
        failed: n('FAILED'),
        replied: n('REPLIED'),
        skipped: n('SKIPPED', 'OPTED_OUT'),
      },
    };
  });
}

export async function getCampaignDetail(deps: Deps, id: string) {
  const c = await deps.db.campaign.findUnique({ where: { id }, include: LIST_INCLUDE });
  if (!c) throw notFound('Campanha não encontrada');
  const [counts, skipReasons, failures, number] = await Promise.all([
    campaignCounts(deps, id),
    deps.db.campaignRecipient.groupBy({ by: ['skipReason'], where: { campaignId: id, status: { in: ['SKIPPED', 'OPTED_OUT'] } }, _count: { _all: true } }),
    deps.db.campaignRecipient.groupBy({
      by: ['errorMessage'],
      where: { campaignId: id, status: 'FAILED' },
      _count: { _all: true },
      orderBy: { _count: { errorMessage: 'desc' } },
      take: 6,
    }),
    deps.db.phoneNumber.findUniqueOrThrow({ where: { id: c.phoneNumberId } }),
  ]);
  const defs = (await deps.db.template.findUniqueOrThrow({ where: { id: c.templateId } })).components as unknown as TemplateComponentDef[];
  return {
    campaign: { ...publicCampaign(c), segment: segmentOf(c), variables: variablesOf(c) },
    counts,
    skipReasons: skipReasons.map((r) => ({
      reason: r.skipReason ?? 'outro',
      label: SKIP_LABEL[r.skipReason ?? ''] ?? r.skipReason ?? 'Outro motivo',
      count: r._count._all,
    })),
    failures: failures.map((f) => ({ message: f.errorMessage ?? 'Erro desconhecido', count: f._count._all })),
    number: {
      id: number.id,
      displayName: number.displayName,
      qualityRating: number.qualityRating,
      sendRatePerMinute: number.sendRatePerMinute,
      dailyCap: dailyCap(number),
      blockReason: numberBlockReason(number),
    },
    templateShape: templateShape(defs),
  };
}

const RECIPIENT_FILTERS: Record<string, Prisma.CampaignRecipientWhereInput> = {
  pending: { status: { in: ['PENDING', 'SENDING'] } },
  sent: { sentAt: { not: null } },
  delivered: { OR: [{ deliveredAt: { not: null } }, { status: { in: ['DELIVERED', 'READ'] } }] },
  read: { OR: [{ readAt: { not: null } }, { status: 'READ' }] },
  replied: { repliedAt: { not: null } },
  failed: { status: 'FAILED' },
  optOuts: { optedOutAt: { not: null } },
  skipped: { status: { in: ['SKIPPED', 'OPTED_OUT'] } },
};

export async function listRecipients(deps: Deps, id: string, filter: string | undefined, page = 1, pageSize = 50) {
  const where: Prisma.CampaignRecipientWhereInput = { campaignId: id, ...(filter ? (RECIPIENT_FILTERS[filter] ?? {}) : {}) };
  const [total, rows] = await Promise.all([
    deps.db.campaignRecipient.count({ where }),
    deps.db.campaignRecipient.findMany({
      where,
      orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { contact: { select: { id: true, name: true, phone: true } } },
    }),
  ]);
  return { total, page, pageSize, recipients: rows };
}

const BOM = String.fromCharCode(0xfeff); // Excel reconhece UTF-8

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // evita fórmulas ao abrir no Excel
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function recipientsCsv(deps: Deps, id: string): Promise<string> {
  const rows = await deps.db.campaignRecipient.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: 'asc' },
    include: { contact: { select: { name: true, phone: true } } },
  });
  const header = ['nome', 'telefone', 'status', 'motivo', 'erro', 'enviado_em', 'entregue_em', 'lido_em', 'respondeu_em', 'saiu_em'];
  const lines = rows.map((r) =>
    [r.contact.name, r.contact.phone, r.status, r.skipReason, r.errorMessage, r.sentAt, r.deliveredAt, r.readAt, r.repliedAt, r.optedOutAt].map(csvCell).join(';'),
  );
  return `${BOM}${[header.join(';'), ...lines].join('\n')}\n`;
}
