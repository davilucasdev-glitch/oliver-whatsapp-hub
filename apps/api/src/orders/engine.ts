import type { OrderNoticeStatus, Prisma } from '@prisma/client';
import { blingClient, BlingNotConnectedError, type BlingClient } from '../bling/client.js';
import { getBlingContact, getOrderDetail } from '../bling/orders.js';
import type { BlingOne, BlingOrderDetail, BlingOrderListItem, BlingPage, BlingPaymentMethod } from '../bling/types.js';
import type { Deps } from '../deps.js';
import { sendTemplateInConversation } from '../inbox/service.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { runTeamAlerts, teamAlertsWanted } from '../team/alerts.js';
import { effectiveOrderConfig } from './situations.js';
import {
  getOrderConfig,
  getPollState,
  groupOf,
  KIND_INFO,
  savePollState,
  type OrderKind,
  type OrderNoticeConfig,
  type SituationGroup,
} from './config.js';

/**
 * Avisos de pedido: a cada ORDERS_POLL_SECONDS pergunta ao Bling quais pedidos mudaram,
 * compara com a última situação vista e manda o template certo para a cliente.
 *
 * Regras (do documento da Ellen):
 *  - nunca o mesmo aviso duas vezes para o mesmo pedido (OrderNotice único por pedido + tipo);
 *  - pedido que volta de situação não reenvia;
 *  - loja TikTok (e outras excluídas) não recebe nada;
 *  - na primeira vez só "fotografa" os pedidos existentes, sem mandar nada;
 *  - nome e telefone vêm do pedido no Bling, nunca de um cadastro paralelo.
 */

const log = childLogger('pedidos:avisos');

const BASELINE_DAYS = 30;
const OVERLAP_MS = 3 * 60_000; // repete os últimos minutos: o relógio do Bling pode atrasar
const MAX_PAGES = 30;

/** "2026-11-18 14:05:00" no horário de Brasília (formato do filtro do Bling). */
export function blingDateTime(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

async function listAltered(client: BlingClient, since: Date): Promise<BlingOrderListItem[]> {
  const out: BlingOrderListItem[] = [];
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const res = await client.get<BlingPage<BlingOrderListItem>>('/pedidos/vendas', { dataAlteracaoInicial: blingDateTime(since), limite: 100, pagina });
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

// ── leitura do pedido ──

const text = (o: BlingOrderDetail) => `${o.observacoes ?? ''}\n${o.observacoesInternas ?? ''}`;

/** "Retirar na loja" nas observações (é como o site e a equipe marcam hoje). */
export function isPickup(o: BlingOrderDetail): boolean {
  return /retir(ar|ada|a)\s+(na|em)\s+loja|retirada\s+na\s+loja|cliente\s+retira/i.test(text(o));
}

export function trackingCodes(o: BlingOrderDetail): string[] {
  return (o.transporte?.volumes ?? []).map((v) => v.codigoRastreamento?.trim()).filter((c): c is string => Boolean(c));
}

/** "PAC CONTRATO AG" → "PAC"; "SEDEX 10" → "SEDEX 10"; transportadora pelo nome. */
export function serviceName(o: BlingOrderDetail): string {
  const raw = (o.transporte?.volumes ?? []).find((v) => v.servico)?.servico?.trim() ?? '';
  if (/^pac\b/i.test(raw)) return 'PAC';
  const sedex = raw.match(/sedex(\s*\d+)?/i);
  if (sedex) return sedex[0].toUpperCase();
  return raw || o.transporte?.contato?.nome?.trim() || 'transportadora';
}

/** Primeiro nome com só a inicial maiúscula ("MARIA EDUARDA" → "Maria"). */
export function firstName(full: string | null | undefined): string {
  const w = (full ?? '').trim().split(/\s+/)[0] ?? '';
  if (!w) return 'cliente';
  return w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1).toLocaleLowerCase('pt-BR');
}

const NBSP = new RegExp('[' + String.fromCharCode(0xa0, 0x202f) + ']', 'g');
const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(NBSP, ' ');

/** O WhatsApp que o site grava nas observações internas; senão o celular/telefone do contato do pedido. */
export async function resolvePhone(deps: Deps, client: BlingClient, o: BlingOrderDetail): Promise<string | null> {
  const fromSite = text(o).match(/whats\s*app[:\s]*([+()\d][\d\s().-]{9,18}\d)/i)?.[1];
  const site = fromSite ? normalizePhone(fromSite) : null;
  if (site) return site;
  const c = o.contato?.id ? await getBlingContact(deps, String(o.contato.id), client) : null;
  for (const raw of [c?.celular, c?.telefone]) {
    const p = raw ? normalizePhone(raw) : null;
    if (p) return p;
  }
  return null;
}

const paymentCache = new Map<number, string>();
async function paymentNames(client: BlingClient, o: BlingOrderDetail): Promise<string> {
  const ids = [...new Set((o.parcelas ?? []).map((p) => p.formaPagamento?.id).filter((x): x is number => Boolean(x)))];
  const names: string[] = [];
  for (const id of ids) {
    let name = paymentCache.get(id);
    if (!name) {
      name = await client
        .get<BlingOne<BlingPaymentMethod>>(`/formas-pagamentos/${id}`)
        .then((r) => r.data.descricao.trim())
        .catch(() => '');
      if (name) paymentCache.set(id, name);
    }
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(' + ') || 'combinado com a loja';
}

async function variables(client: BlingClient, cfg: OrderNoticeConfig, kind: OrderKind, o: BlingOrderDetail): Promise<string[]> {
  const nome = firstName(o.contato?.nome);
  const numero = String(o.numero);
  switch (kind) {
    case 'RECEBIDO':
      return [nome, numero, brl(o.total), await paymentNames(client, o)];
    case 'PRONTO_RETIRAR':
      return [nome, numero, cfg.storeInfo.trim()];
    case 'ENVIADO': {
      const codes = trackingCodes(o);
      return [nome, numero, serviceName(o), codes.join(', '), cfg.trackingUrl.replaceAll('{codigo}', encodeURIComponent(codes[0] ?? ''))];
    }
    default:
      return [nome, numero];
  }
}

/** Qual aviso a situação atual pede (ou por que ainda não). */
export function decideKind(group: SituationGroup, o: BlingOrderDetail): { kind: OrderKind; wait?: string } | null {
  switch (group) {
    case 'ABERTO':
      return { kind: 'RECEBIDO' };
    case 'SEPARANDO':
      return { kind: 'SEPARANDO' };
    case 'ETIQUETA':
      return isPickup(o) ? { kind: 'PRONTO_RETIRAR' } : null; // envio: espera o "Enviado" com rastreio
    case 'ENVIADO':
      if (trackingCodes(o).length) return { kind: 'ENVIADO' };
      if (isPickup(o)) return { kind: 'PRONTO_RETIRAR' };
      return { kind: 'ENVIADO', wait: 'Enviado sem código de rastreio ainda (manda quando a etiqueta for emitida)' };
    case 'ATENDIDO':
      return { kind: 'ENTREGUE' };
    case 'CANCELADO':
      return { kind: 'CANCELADO' };
  }
}

// ── envio ──

type Outcome = { status: OrderNoticeStatus; reason?: string } | null;

/** Ordem das etapas (retirada e envio são a mesma etapa). */
const FLOW_RANK: Record<OrderKind, number> = { RECEBIDO: 1, SEPARANDO: 2, PRONTO_RETIRAR: 3, ENVIADO: 3, ENTREGUE: 4, CANCELADO: 5 };

async function record(
  deps: Deps,
  o: BlingOrderDetail,
  kind: OrderKind,
  data: { status: OrderNoticeStatus; reason?: string | null } & Partial<Prisma.OrderNoticeUncheckedCreateInput>,
) {
  const row = { orderNumber: o.numero, customerName: o.contato?.nome ?? null, reason: null, ...data };
  await deps.db.orderNotice.upsert({
    where: { blingOrderId_kind: { blingOrderId: String(o.id), kind } },
    create: { blingOrderId: String(o.id), kind, ...row },
    update: row,
  });
}

async function pickNumber(deps: Deps, cfg: OrderNoticeConfig) {
  if (cfg.phoneNumberId) {
    const n = await deps.db.phoneNumber.findUnique({ where: { id: cfg.phoneNumberId } });
    if (n?.isActive) return n;
  }
  return deps.db.phoneNumber.findFirst({ where: { isActive: true, role: { in: ['ATTENDANCE', 'BOTH'] } }, orderBy: { createdAt: 'asc' } });
}

/** Contato e conversa de quem recebe (no modo de teste, o número de teste). */
async function conversationFor(deps: Deps, phone: string, numberId: string, o: BlingOrderDetail, isCustomer: boolean) {
  let contact = await deps.db.contact.findUnique({ where: { phone } });
  if (!contact) {
    const blingId = isCustomer && o.contato?.id ? String(o.contato.id) : null;
    const taken = blingId ? await deps.db.contact.findUnique({ where: { blingContactId: blingId } }) : null;
    contact = await deps.db.contact.create({
      data: { phone, name: isCustomer ? o.contato?.nome?.trim() || null : null, blingContactId: taken ? null : blingId },
    });
  } else if (isCustomer && !contact.blingContactId && o.contato?.id) {
    const blingId = String(o.contato.id);
    if (!(await deps.db.contact.findUnique({ where: { blingContactId: blingId } }))) {
      contact = await deps.db.contact.update({ where: { id: contact.id }, data: { blingContactId: blingId, name: contact.name ?? o.contato.nome?.trim() } });
    }
  }
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: numberId } },
    create: { contactId: contact.id, phoneNumberId: numberId },
    update: {},
  });
  return { contact, conv };
}

export async function deliver(deps: Deps, client: BlingClient, cfg: OrderNoticeConfig, kind: OrderKind, o: BlingOrderDetail, wait?: string): Promise<Outcome> {
  const id = String(o.id);
  const existing = await deps.db.orderNotice.findUnique({ where: { blingOrderId_kind: { blingOrderId: id, kind } } });
  if (existing?.status === 'SENT' || existing?.status === 'FAILED') return null; // nunca duas vezes
  if (!cfg.kinds[kind].enabled) return null;
  if ((kind === 'ENTREGUE' || kind === 'CANCELADO') && cfg.onlyAfterFlow) {
    const before = await deps.db.orderNotice.count({ where: { blingOrderId: id, status: 'SENT' } });
    if (!before) return null; // venda de balcão: sem aviso
  }
  // pedido voltou de situação: não manda aviso de uma etapa anterior à que a cliente já recebeu
  if (kind !== 'CANCELADO') {
    const sent = await deps.db.orderNotice.findMany({ where: { blingOrderId: id, status: 'SENT' }, select: { kind: true } });
    if (sent.some((s) => s.kind !== 'CANCELADO' && FLOW_RANK[s.kind] > FLOW_RANK[kind])) return null;
  }
  // já avisou que está pronto para retirar: não manda "saiu" do mesmo pedido (e vice-versa)
  if (kind === 'ENVIADO' || kind === 'PRONTO_RETIRAR') {
    const other = kind === 'ENVIADO' ? 'PRONTO_RETIRAR' : 'ENVIADO';
    if (await deps.db.orderNotice.findFirst({ where: { blingOrderId: id, kind: other, status: 'SENT' } })) return null;
  }

  const skip = async (reason: string): Promise<Outcome> => {
    await record(deps, o, kind, { status: 'SKIPPED', reason });
    return { status: 'SKIPPED', reason };
  };
  if (wait) return skip(wait);

  const phone = await resolvePhone(deps, client, o);
  if (!phone) return skip('Pedido sem telefone (nem WhatsApp nas observações, nem celular no contato do Bling)');
  if (kind === 'PRONTO_RETIRAR' && !cfg.storeInfo.trim()) return skip('Falta o endereço e horário da loja em Avisos de pedido');

  const number = await pickNumber(deps, cfg);
  if (!number) return skip('Nenhum número de atendimento ativo para enviar');
  const tplName = cfg.kinds[kind].template;
  const tpl = await deps.db.template.findFirst({ where: { name: tplName, wabaId: number.wabaId, status: 'APPROVED' } });
  if (!tpl) return skip(`Template "${tplName}" ainda não está aprovado pela Meta`);

  const test = cfg.testPhone ? normalizePhone(cfg.testPhone) : null;
  const target = test ?? phone;
  const vars = await variables(client, cfg, kind, o);
  if (vars.some((v) => !v.trim())) return skip('Faltou um dado do pedido para o template');
  const base = { phone, sentTo: target, templateName: tpl.name };
  try {
    const { contact, conv } = await conversationFor(deps, target, number.id, o, !test);
    const msg = await sendTemplateInConversation(deps, conv.id, { templateId: tpl.id, body: vars }, 'SYSTEM');
    await record(deps, o, kind, { status: 'SENT', ...base, contactId: contact.id, conversationId: conv.id, messageId: msg?.id ?? null });
    log.info({ pedido: o.numero, aviso: kind, teste: Boolean(test) }, 'Aviso de pedido enviado');
    return { status: 'SENT' };
  } catch (err) {
    const reason = (err as Error).message.slice(0, 300);
    await record(deps, o, kind, { status: 'FAILED', reason, ...base });
    log.warn({ pedido: o.numero, aviso: kind, err: reason }, 'Aviso de pedido não enviado');
    return { status: 'FAILED', reason };
  }
}

// ── rodada ──

export interface PollResult {
  ran: boolean;
  teamAlerts?: number;
  reason?: string;
  baseline?: number;
  seen: number;
  sent: number;
  skipped: number;
  failed: number;
}

function stateInfo(it: BlingOrderListItem) {
  return {
    numero: it.numero,
    lojaId: it.loja?.id ? String(it.loja.id) : null,
    situacaoId: it.situacao.id,
    contactBlingId: it.contato?.id ? String(it.contato.id) : null,
    contactName: it.contato?.nome?.trim() || null,
    orderDate: it.data && !it.data.startsWith('0000') ? it.data : null,
  };
}

/** Guarda a data da última compra no contato (para a "hora de repor"). */
async function touchLastOrder(deps: Deps, it: BlingOrderListItem) {
  if (!it.contato?.id || !it.data || it.data.startsWith('0000') || it.situacao.id === 12) return;
  await deps.db.contact.updateMany({
    where: { blingContactId: String(it.contato.id), OR: [{ lastOrderDate: null }, { lastOrderDate: { lt: it.data } }] },
    data: { lastOrderDate: it.data },
  });
}

/** Uma rodada: pedidos alterados desde a última → aviso para quem mudou de situação. */
export async function pollOrders(deps: Deps, opts: { now?: Date; force?: boolean } = {}): Promise<PollResult> {
  const now = opts.now ?? new Date();
  const result: PollResult = { ran: false, seen: 0, sent: 0, skipped: 0, failed: 0 };
  const cfg = await effectiveOrderConfig(deps);
  // os avisos da equipe também dependem desta leitura, mesmo com os avisos às clientes desligados
  const team = await teamAlertsWanted(deps.db);
  if (!cfg.enabled && !opts.force && !team) return { ...result, reason: 'Avisos de pedido desligados' };
  if (!(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }))) {
    return { ...result, reason: 'Bling não conectado' };
  }
  const st = await getPollState(deps.db);
  const client = blingClient(deps);
  try {
    if (!st.baselineAt || !st.cursor) {
      // primeira vez: só registra a situação atual dos pedidos recentes, sem mandar nada
      const items = await listAltered(client, new Date(now.getTime() - BASELINE_DAYS * 86_400_000));
      for (const it of items) {
        const info = stateInfo(it);
        // na foto inicial não sabemos desde quando o pedido está na situação: usa a data do pedido
        const since = info.orderDate ? new Date(`${info.orderDate}T15:00:00Z`) : now;
        await deps.db.orderState.upsert({ where: { blingOrderId: String(it.id) }, create: { blingOrderId: String(it.id), ...info, situacaoSince: since }, update: { ...info, situacaoSince: since } });
        await touchLastOrder(deps, it);
      }
      await savePollState(deps.db, { ...st, cursor: now.toISOString(), baselineAt: now.toISOString(), lastRunAt: now.toISOString(), lastError: null, lastSummary: { seen: items.length, sent: 0, skipped: 0, failed: 0 } });
      log.info({ pedidos: items.length }, 'Avisos de pedido: foto inicial dos pedidos (nenhum aviso enviado)');
      return { ...result, ran: true, baseline: items.length, seen: items.length };
    }

    const items = await listAltered(client, new Date(new Date(st.cursor).getTime() - OVERLAP_MS));
    const newSeparando: { numero: number; contactName: string | null; blingOrderId: string }[] = [];
    for (const it of items.sort((a, b) => a.numero - b.numero)) {
      result.seen++;
      const id = String(it.id);
      const lojaId = it.loja?.id ? String(it.loja.id) : null;
      const prev = await deps.db.orderState.findUnique({ where: { blingOrderId: id } });
      const changed = !prev || prev.situacaoId !== it.situacao.id;
      const info = stateInfo(it);
      await deps.db.orderState.upsert({
        where: { blingOrderId: id },
        create: { blingOrderId: id, ...info, situacaoSince: now },
        update: { ...info, ...(changed ? { situacaoSince: now } : {}) },
      });
      await touchLastOrder(deps, it);
      const group = groupOf(cfg, it.situacao.id);
      // aviso interno vale para toda loja (pedido do TikTok também é separado aqui)
      if (group === 'SEPARANDO' && changed) newSeparando.push({ numero: it.numero, contactName: it.contato?.nome ?? null, blingOrderId: id });
      if (!cfg.enabled && !opts.force) continue; // avisos às clientes desligados: só acompanha
      if (lojaId && cfg.excludedStores.includes(lojaId)) continue;
      if (!group) continue;
      // "Enviado" sem rastreio fica esperando: quando a etiqueta entra, o pedido aparece alterado de novo
      const waitingTracking =
        group === 'ENVIADO' && (await deps.db.orderNotice.findFirst({ where: { blingOrderId: id, kind: 'ENVIADO', status: 'SKIPPED' } }));
      if (!changed && !waitingTracking) continue;

      const detail = await getOrderDetail(deps, it.id, client);
      if (!detail) continue;
      const decision = decideKind(group, detail);
      if (!decision) continue;
      const out = await deliver(deps, client, cfg, decision.kind, detail, decision.wait);
      if (out?.status === 'SENT') result.sent++;
      else if (out?.status === 'SKIPPED') result.skipped++;
      else if (out?.status === 'FAILED') result.failed++;
    }
    await savePollState(deps.db, { ...st, cursor: now.toISOString(), lastRunAt: now.toISOString(), lastError: null, lastSummary: { seen: result.seen, sent: result.sent, skipped: result.skipped, failed: result.failed } });
    if (team) {
      const t = await runTeamAlerts(deps, { now, newSeparando }).catch((err: Error) => {
        log.warn({ err: err.message }, 'Avisos para a equipe falharam');
        return { sent: 0 };
      });
      result.teamAlerts = t.sent;
    }
    return { ...result, ran: true };
  } catch (err) {
    const msg = err instanceof BlingNotConnectedError ? err.message : `Erro ao ler pedidos do Bling: ${(err as Error).message}`;
    await savePollState(deps.db, { ...st, lastRunAt: now.toISOString(), lastError: msg.slice(0, 300) });
    log.warn({ err: msg }, 'Rodada de avisos de pedido falhou');
    return { ...result, reason: msg };
  }
}

/**
 * Teste: manda o aviso de um pedido real SÓ para o número de teste, sem registrar e sem
 * contar como enviado (o pedido continua recebendo o aviso de verdade depois).
 */
export async function sendTestNotice(deps: Deps, kind: OrderKind, orderNumber: number) {
  const cfg = await getOrderConfig(deps.db);
  const test = cfg.testPhone ? normalizePhone(cfg.testPhone) : null;
  if (!test) throw new Error('Informe o número de teste (com DDD) antes de testar.');
  const client = blingClient(deps);
  const list = await client.get<BlingPage<BlingOrderListItem>>('/pedidos/vendas', { numero: orderNumber, limite: 5 });
  const item = list.data.find((x) => x.numero === orderNumber);
  const o = item ? await getOrderDetail(deps, item.id, client) : null;
  if (!o) throw new Error(`Pedido nº ${orderNumber} não encontrado no Bling.`);
  const number = await pickNumber(deps, cfg);
  if (!number) throw new Error('Nenhum número de atendimento ativo.');
  const tplName = cfg.kinds[kind].template;
  const tpl = await deps.db.template.findFirst({ where: { name: tplName, wabaId: number.wabaId, status: 'APPROVED' } });
  if (!tpl) throw new Error(`O template "${tplName}" ainda não está aprovado pela Meta.`);
  if (kind === 'PRONTO_RETIRAR' && !cfg.storeInfo.trim()) throw new Error('Preencha o endereço e horário da loja.');
  if (kind === 'ENVIADO' && !trackingCodes(o).length) throw new Error(`O pedido nº ${orderNumber} ainda não tem código de rastreio.`);
  const vars = await variables(client, cfg, kind, o);
  const { conv } = await conversationFor(deps, test, number.id, o, false);
  await sendTemplateInConversation(deps, conv.id, { templateId: tpl.id, body: vars }, 'SYSTEM');
  return { sentTo: test, variables: vars, customerPhone: await resolvePhone(deps, client, o), conversationId: conv.id };
}

export { listSaleSituations } from './situations.js';

export { KIND_INFO };
