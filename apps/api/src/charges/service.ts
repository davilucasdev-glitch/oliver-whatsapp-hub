import type { Receivable } from '@prisma/client';
import type { Deps } from '../deps.js';
import { badRequest, HttpError } from '../http/errors.js';
import { sendTemplateInConversation, type Agent } from '../inbox/service.js';
import { childLogger } from '../lib/logger.js';
import { firstName } from '../orders/engine.js';
import { renderTemplate } from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { addDays, CHARGE_INFO, daysBetween, getChargeConfig, money, spDate, TIKTOK_STORE_ID, type ChargeConfig, type ChargeKindKey } from './config.js';

const log = childLogger('cobranca');

const NBSP = new RegExp('[' + String.fromCharCode(0xa0, 0x202f) + ']', 'g');
export const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(NBSP, ' ');
const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const lateText = (d: number) => (d === 1 ? '1 dia' : `${d} dias`);

export interface ChargeRow {
  key: string;
  kind: ChargeKindKey;
  contactBlingId: string;
  name: string;
  phone: string | null;
  phoneSource: string | null;
  receivables: { id: string; valor: number; remaining: number; remainingKnown: boolean; vencimento: string; orderNumber: string | null }[];
  /** valor da parcela / em atraso / pago */
  amount: number;
  /** saldo total em aberto da cliente no crediário */
  balance: number;
  balanceKnown: boolean;
  dueDate: string | null;
  daysLate: number | null;
  variables: string[];
  preview: string;
  alreadySent: boolean;
  lastCharge: { kind: string; at: string; by: string | null } | null;
  /** por que não dá para enviar (sem telefone, sem Pix, template não aprovado) */
  blocked: string | null;
}

export interface ChargeLists {
  today: string;
  lembrete: ChargeRow[];
  hoje: ChargeRow[];
  atraso: ChargeRow[];
  pagos: ChargeRow[];
}

/** Contas que entram na cobrança: emitidas a partir do corte, fora da loja TikTok. */
function eligible(cfg: ChargeConfig, r: Receivable) {
  return r.emissao >= cfg.cutoff && r.lojaId !== TIKTOK_STORE_ID;
}

export function variablesFor(cfg: ChargeConfig, kind: ChargeKindKey, row: Pick<ChargeRow, 'name' | 'amount' | 'balance' | 'dueDate' | 'daysLate'>): string[] {
  const nome = firstName(row.name);
  switch (kind) {
    case 'LEMBRETE':
      return [nome, brl(row.amount), ddmm(row.dueDate ?? ''), cfg.pixKey.trim()];
    case 'VENCE_HOJE':
      return [nome, brl(row.amount), cfg.pixKey.trim()];
    case 'ATRASO':
      return [nome, brl(row.amount), lateText(row.daysLate ?? 0), brl(row.balance)];
    case 'PAGAMENTO':
      return [nome, brl(row.amount), brl(row.balance)];
  }
}

export async function buildChargeLists(deps: Deps, now = new Date()): Promise<ChargeLists> {
  const cfg = await getChargeConfig(deps.db);
  const today = spDate(now);
  const all = (await deps.db.receivable.findMany({ orderBy: [{ vencimento: 'asc' }, { blingId: 'asc' }] })).filter((r) => eligible(cfg, r));
  const open = all.filter((r) => (r.situacao === 1 || r.situacao === 3) && r.remaining > 0.009);

  const balance = new Map<string, { total: number; known: boolean }>();
  for (const r of open) {
    const b = balance.get(r.contactBlingId) ?? { total: 0, known: true };
    b.total = money(b.total + r.remaining);
    b.known &&= r.remainingKnown;
    balance.set(r.contactBlingId, b);
  }

  const templates = await deps.db.template.findMany({ where: { name: { in: Object.values(cfg.templates) }, status: { not: 'DELETED' } } });
  const tplOf = (k: ChargeKindKey) => templates.find((t) => t.name === cfg.templates[k]) ?? null;
  const sent = await deps.db.chargeNotice.findMany({ where: { status: 'SENT', createdAt: { gte: new Date(now.getTime() - 60 * 86_400_000) } }, orderBy: { createdAt: 'desc' } });
  const sentKeys = new Set(sent.map((s) => s.key));
  const users = new Map((await deps.db.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email.split('@')[0]!]));
  const lastByContact = new Map<string, ChargeRow['lastCharge']>();
  for (const s of sent) {
    if (!lastByContact.has(s.contactBlingId)) lastByContact.set(s.contactBlingId, { kind: s.kind, at: s.createdAt.toISOString(), by: s.sentByUserId ? (users.get(s.sentByUserId) ?? null) : null });
  }

  const make = (kind: ChargeKindKey, key: string, rs: Receivable[], extra: { amount: number; dueDate?: string | null; daysLate?: number | null }): ChargeRow => {
    const first = rs[0]!;
    const b = balance.get(first.contactBlingId) ?? { total: 0, known: true };
    const phone = rs.find((r) => r.phone)?.phone ?? null;
    const base = { name: first.contactName, amount: extra.amount, balance: b.total, dueDate: extra.dueDate ?? null, daysLate: extra.daysLate ?? null };
    const variables = variablesFor(cfg, kind, base);
    const tpl = tplOf(kind);
    const preview = tpl
      ? renderTemplate(tpl.components as unknown as TemplateComponentDef[], { body: variables })
      : CHARGE_INFO[kind].suggested.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => variables[Number(n) - 1] ?? '');
    let blocked: string | null = null;
    if (!phone) blocked = 'Sem telefone no pedido nem no cadastro do Bling';
    else if ((kind === 'LEMBRETE' || kind === 'VENCE_HOJE') && !cfg.pixKey.trim()) blocked = 'Falta a chave Pix nas configurações';
    else if (!tpl) blocked = `Template "${cfg.templates[kind]}" não existe ainda`;
    else if (tpl.status !== 'APPROVED') blocked = `Template "${tpl.name}" ainda não aprovado pela Meta`;
    return {
      key,
      kind,
      contactBlingId: first.contactBlingId,
      ...base,
      phone,
      phoneSource: rs.find((r) => r.phone)?.phoneSource ?? null,
      receivables: rs.map((r) => ({ id: r.blingId, valor: r.valor, remaining: r.remaining, remainingKnown: r.remainingKnown, vencimento: r.vencimento, orderNumber: r.orderNumber })),
      balanceKnown: b.known,
      variables,
      preview,
      alreadySent: sentKeys.has(key),
      lastCharge: lastByContact.get(first.contactBlingId) ?? null,
      blocked,
    };
  };

  const groupBy = <T>(items: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of items) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return [...m.values()];
  };
  const ids = (rs: Receivable[]) => rs.map((r) => r.blingId).sort().join(',');
  const sum = (rs: Receivable[]) => money(rs.reduce((a, r) => a + r.remaining, 0));
  const byName = (a: ChargeRow, b: ChargeRow) => a.name.localeCompare(b.name, 'pt-BR');

  const reminderDay = addDays(today, cfg.reminderDays);
  const lembrete = groupBy(open.filter((r) => r.vencimento === reminderDay), (r) => r.contactBlingId).map((rs) =>
    make('LEMBRETE', `LEMBRETE:${ids(rs)}`, rs, { amount: sum(rs), dueDate: reminderDay }),
  );
  const hoje = groupBy(open.filter((r) => r.vencimento === today), (r) => r.contactBlingId).map((rs) =>
    make('VENCE_HOJE', `VENCE_HOJE:${ids(rs)}`, rs, { amount: sum(rs), dueDate: today }),
  );
  const atraso = groupBy(open.filter((r) => r.vencimento < today), (r) => r.contactBlingId)
    .map((rs) => make('ATRASO', `ATRASO:${rs[0]!.contactBlingId}:${today}`, rs, { amount: sum(rs), daysLate: Math.max(...rs.map((r) => daysBetween(r.vencimento, today))) }))
    .sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0) || byName(a, b));
  const pagos = all
    .filter((r) => r.lastPaymentAt && r.lastPaymentAmount && now.getTime() - r.lastPaymentAt.getTime() < 7 * 86_400_000)
    .sort((a, b) => b.lastPaymentAt!.getTime() - a.lastPaymentAt!.getTime())
    .map((r) => make('PAGAMENTO', `PAGAMENTO:${r.blingId}:${r.paymentSeq}`, [r], { amount: r.lastPaymentAmount! }));

  return { today, lembrete: lembrete.sort(byName), hoje: hoje.sort(byName), atraso, pagos };
}

async function pickNumber(deps: Deps, cfg: ChargeConfig) {
  if (cfg.phoneNumberId) {
    const n = await deps.db.phoneNumber.findUnique({ where: { id: cfg.phoneNumberId } });
    if (n?.isActive) return n;
  }
  return deps.db.phoneNumber.findFirst({ where: { isActive: true, role: { in: ['ATTENDANCE', 'BOTH'] } }, orderBy: { createdAt: 'asc' } });
}

async function ensureConversation(deps: Deps, phone: string, numberId: string, name: string, blingContactId: string) {
  let contact = await deps.db.contact.findUnique({ where: { phone } });
  if (!contact) {
    const taken = await deps.db.contact.findUnique({ where: { blingContactId } });
    contact = await deps.db.contact.create({ data: { phone, name, blingContactId: taken ? null : blingContactId } });
  } else if (!contact.blingContactId && !(await deps.db.contact.findUnique({ where: { blingContactId } }))) {
    contact = await deps.db.contact.update({ where: { id: contact.id }, data: { blingContactId, name: contact.name ?? name } });
  }
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: numberId } },
    create: { contactId: contact.id, phoneNumberId: numberId },
    update: {},
  });
  return { contact, conv };
}

export interface SendChargeResult {
  key: string;
  status: 'SENT' | 'FAILED';
  reason?: string;
  conversationId?: string;
}

/**
 * Envia uma cobrança (sempre a pedido de alguém da equipe). Recalcula a linha na hora:
 * se a conta já foi paga ou mudou, o que vale é o Bling de agora, não o que estava na tela.
 */
export async function sendCharge(deps: Deps, who: Agent, input: { key: string; balance?: number }, lists?: ChargeLists): Promise<SendChargeResult> {
  const cfg = await getChargeConfig(deps.db);
  const all = lists ?? (await buildChargeLists(deps));
  const row = [...all.lembrete, ...all.hoje, ...all.atraso, ...all.pagos].find((r) => r.key === input.key);
  if (!row) throw new HttpError(409, 'Essa cobrança não está mais na lista (a conta pode ter sido paga ou mudou no Bling). Atualize a tela.');
  if (row.alreadySent) throw new HttpError(409, 'Essa mensagem já foi enviada.');
  if (row.blocked) throw badRequest(row.blocked);
  const needsBalance = row.kind === 'ATRASO' || row.kind === 'PAGAMENTO';
  if (needsBalance && !row.balanceKnown && input.balance === undefined) {
    throw badRequest('Esta cliente tem conta parcialmente paga e o Bling não informou quanto falta. Confira o saldo no crediário e informe antes de enviar.');
  }
  const final = input.balance !== undefined && needsBalance ? { ...row, balance: money(input.balance) } : row;
  const variables = variablesFor(cfg, row.kind, final);

  const number = await pickNumber(deps, cfg);
  if (!number) throw badRequest('Nenhum número de atendimento ativo.');
  const tpl = await deps.db.template.findFirst({ where: { name: cfg.templates[row.kind], wabaId: number.wabaId, status: 'APPROVED' } });
  if (!tpl) throw badRequest(`Template "${cfg.templates[row.kind]}" não aprovado para o número ${number.displayName}.`);

  const base = {
    kind: row.kind,
    contactBlingId: row.contactBlingId,
    contactName: row.name,
    receivableIds: row.receivables.map((r) => r.id),
    amount: row.amount,
    balance: final.balance,
    variables,
    phone: row.phone,
    templateName: tpl.name,
    sentByUserId: who.id,
  };
  try {
    const { conv } = await ensureConversation(deps, row.phone!, number.id, row.name, row.contactBlingId);
    const msg = await sendTemplateInConversation(deps, conv.id, { templateId: tpl.id, body: variables }, 'HUMAN', who);
    // cobrança fica com quem cuida do crediário (a Ellen), para o comprovante cair com ela
    if (cfg.ownerUserId) {
      const owner = await deps.db.user.findUnique({ where: { id: cfg.ownerUserId } });
      if (owner?.active) await deps.db.conversation.update({ where: { id: conv.id }, data: { assignedToId: owner.id } });
    }
    const data = { ...base, status: 'SENT' as const, reason: null, conversationId: conv.id, messageId: msg?.id ?? null };
    await deps.db.chargeNotice.upsert({ where: { key: row.key }, create: { key: row.key, ...data }, update: data });
    log.info({ tipo: row.kind, cliente: row.contactBlingId, por: who.name }, 'Cobrança enviada');
    return { key: row.key, status: 'SENT', conversationId: conv.id };
  } catch (err) {
    const reason = (err as Error).message.slice(0, 300);
    const data = { ...base, status: 'FAILED' as const, reason };
    // falha não bloqueia: dá para tentar de novo (a chave é reaproveitada)
    await deps.db.chargeNotice.upsert({ where: { key: row.key }, create: { key: row.key, ...data }, update: data });
    log.warn({ tipo: row.kind, cliente: row.contactBlingId, err: reason }, 'Cobrança não enviada');
    return { key: row.key, status: 'FAILED', reason };
  }
}
