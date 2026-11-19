import type { Deps } from '../deps.js';
import { normalizePhone } from '../lib/phone.js';
import { blingClient, BlingApiError, type BlingClient } from './client.js';
import type { BlingContact, BlingOne, BlingOrderDetail, BlingOrderListItem, BlingPage, BlingSituation } from './types.js';

/**
 * Consulta de pedidos e vínculo de contatos com o Bling.
 * Regra de privacidade (usada pelo bot na etapa 5): só devolvemos um pedido quando ele é do
 * cliente que está perguntando — mesmo CPF/CNPJ do cadastro ou mesmo telefone do WhatsApp.
 */

type OrderDeps = Pick<Deps, 'env' | 'db'>;

export interface OrderSummary {
  id: string;
  numero: number;
  numeroLoja: string | null;
  data: string | null;
  dataSaida: string | null;
  dataPrevista: string | null;
  situacao: string;
  total: number;
  frete: number | null;
  itens: { descricao: string; quantidade: number; valor: number }[];
  transportadora: string | null;
  rastreios: string[];
  notaFiscalEmitida: boolean;
  cliente: string;
}

export const onlyDigits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** CPF (11) ou CNPJ (14) com dígitos verificadores corretos. */
export function isValidDocument(raw: string): boolean {
  const d = onlyDigits(raw);
  if (/^(\d)\1+$/.test(d)) return false;
  if (d.length === 11) {
    const calc = (len: number) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
  }
  if (d.length === 14) {
    const calc = (len: number) => {
      const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const sum = w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0);
      const r = sum % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }
  return false;
}

/**
 * Compara telefones ignorando formato e o "9" extra de celular
 * (o WhatsApp às vezes entrega o wa_id brasileiro sem ele).
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = a ? normalizePhone(a) : null;
  const nb = b ? normalizePhone(b) : null;
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith('+55') && nb.startsWith('+55')) {
    const key = (e: string) => `${e.slice(3, 5)}${e.slice(-8)}`;
    return key(na) === key(nb);
  }
  return false;
}

const blankDate = (d: string | undefined | null) => (!d || d.startsWith('0000') ? null : d);

/** Situações padrão do Bling (pedidos de venda). As personalizadas são buscadas na API. */
const DEFAULT_SITUATIONS: Record<number, string> = {
  6: 'Em aberto',
  9: 'Atendido',
  12: 'Cancelado',
  15: 'Em andamento',
  18: 'Venda agenciada',
  21: 'Em digitação',
  24: 'Verificado',
};
const situationCache = new Map<number, string>();

export async function situationName(client: BlingClient, id: number): Promise<string> {
  const known = DEFAULT_SITUATIONS[id] ?? situationCache.get(id);
  if (known) return known;
  try {
    const s = (await client.get<BlingOne<BlingSituation>>(`/situacoes/${id}`)).data;
    situationCache.set(id, s.nome);
    return s.nome;
  } catch {
    return `Situação ${id}`;
  }
}

export async function getBlingContact(deps: OrderDeps, id: string, client = blingClient(deps)): Promise<BlingContact | null> {
  try {
    return (await client.get<BlingOne<BlingContact>>(`/contatos/${id}`)).data;
  } catch (err) {
    if (err instanceof BlingApiError && err.status === 404) return null;
    throw err;
  }
}

/** Acha o cadastro no Bling pelo CPF/CNPJ (exato) ou pelo telefone (confere o número antes de aceitar). */
export async function findBlingContact(
  deps: OrderDeps,
  by: { document?: string | null; phone?: string | null },
  client = blingClient(deps),
): Promise<BlingContact | null> {
  const doc = onlyDigits(by.document);
  if (doc) {
    const res = await client.get<BlingPage<BlingContact>>('/contatos', { numeroDocumento: doc, limite: 10 });
    const hit = res.data.find((c) => onlyDigits(c.numeroDocumento) === doc);
    if (hit) return hit;
  }
  const phone = by.phone ? normalizePhone(by.phone) : null;
  if (phone?.startsWith('+55')) {
    const national = phone.slice(3);
    const res = await client.get<BlingPage<BlingContact>>('/contatos', { pesquisa: national, limite: 20 });
    // a listagem nem sempre traz os telefones: confirma no cadastro completo
    for (const c of res.data.slice(0, 5)) {
      const full = c.celular || c.telefone ? c : await getBlingContact(deps, String(c.id), client);
      if (full && (samePhone(full.celular, phone) || samePhone(full.telefone, phone))) return full;
    }
  }
  return null;
}

export async function getOrderDetail(deps: OrderDeps, id: string | number, client = blingClient(deps)): Promise<BlingOrderDetail | null> {
  try {
    return (await client.get<BlingOne<BlingOrderDetail>>(`/pedidos/vendas/${id}`)).data;
  } catch (err) {
    if (err instanceof BlingApiError && err.status === 404) return null;
    throw err;
  }
}

export async function summarizeOrder(client: BlingClient, o: BlingOrderDetail): Promise<OrderSummary> {
  const volumes = o.transporte?.volumes ?? [];
  return {
    id: String(o.id),
    numero: o.numero,
    numeroLoja: o.numeroLoja || null,
    data: blankDate(o.data),
    dataSaida: blankDate(o.dataSaida),
    dataPrevista: blankDate(o.dataPrevista),
    situacao: await situationName(client, o.situacao.id),
    total: o.total,
    frete: o.transporte?.frete ?? null,
    itens: (o.itens ?? []).map((i) => ({ descricao: i.descricao, quantidade: i.quantidade, valor: i.valor })),
    transportadora: o.transporte?.contato?.nome?.trim() || volumes.find((v) => v.servico)?.servico || null,
    rastreios: volumes.map((v) => v.codigoRastreamento?.trim()).filter((c): c is string => Boolean(c)),
    notaFiscalEmitida: Boolean(o.notaFiscal?.id),
    cliente: o.contato.nome,
  };
}

/** Últimos pedidos de um cadastro do Bling (mais recentes primeiro). */
export async function listContactOrders(deps: OrderDeps, blingContactId: string, limit = 5, client = blingClient(deps)): Promise<OrderSummary[]> {
  const res = await client.get<BlingPage<BlingOrderListItem>>('/pedidos/vendas', { idContato: blingContactId, limite: Math.min(limit, 100) });
  const recent = [...res.data].sort((a, b) => b.numero - a.numero).slice(0, limit);
  const out: OrderSummary[] = [];
  for (const item of recent) {
    const detail = await getOrderDetail(deps, item.id, client);
    if (detail) out.push(await summarizeOrder(client, detail));
  }
  return out;
}

export type OrderLookupResult =
  | { status: 'found'; orders: OrderSummary[]; blingContactId: string | null }
  | { status: 'not_found' }
  | { status: 'needs_document' }
  | { status: 'not_owner' };

/**
 * Consulta segura de pedidos para o cliente que está no WhatsApp.
 * - Com número do pedido: devolve só se o CPF/CNPJ ou o telefone do pedido for do cliente.
 * - Sem número: acha o cadastro do cliente (CPF/CNPJ ou telefone) e lista os últimos pedidos.
 */
export async function lookupOrdersForCustomer(
  deps: OrderDeps,
  who: { phone: string; document?: string | null; blingContactId?: string | null },
  orderNumber?: number | null,
  client = blingClient(deps),
): Promise<OrderLookupResult> {
  const doc = onlyDigits(who.document);

  if (orderNumber) {
    const res = await client.get<BlingPage<BlingOrderListItem>>('/pedidos/vendas', { numero: orderNumber, limite: 5 });
    const item = res.data.find((o) => o.numero === orderNumber);
    if (!item) return { status: 'not_found' };
    const detail = await getOrderDetail(deps, item.id, client);
    if (!detail) return { status: 'not_found' };
    const orderDoc = onlyDigits(detail.contato.numeroDocumento);
    let owner = (doc && orderDoc === doc) || (who.blingContactId && String(detail.contato.id) === who.blingContactId);
    if (!owner) {
      const c = await getBlingContact(deps, String(detail.contato.id), client);
      owner = Boolean(c && (samePhone(c.celular, who.phone) || samePhone(c.telefone, who.phone)));
    }
    if (!owner) return doc ? { status: 'not_owner' } : { status: 'needs_document' };
    return { status: 'found', orders: [await summarizeOrder(client, detail)], blingContactId: String(detail.contato.id) };
  }

  let contactId = who.blingContactId ?? null;
  if (!contactId) {
    const c = await findBlingContact(deps, { document: doc || null, phone: who.phone }, client);
    contactId = c ? String(c.id) : null;
  }
  if (!contactId) return doc ? { status: 'not_found' } : { status: 'needs_document' };
  const orders = await listContactOrders(deps, contactId, 3, client);
  return orders.length ? { status: 'found', orders, blingContactId: contactId } : { status: 'not_found' };
}

/** Vincula um contato do WhatsApp ao cadastro do Bling e completa nome/e-mail/CPF vazios. */
export async function linkContactToBling(deps: OrderDeps, contactId: string, client = blingClient(deps)) {
  const contact = await deps.db.contact.findUnique({ where: { id: contactId } });
  if (!contact) return null;
  const found = contact.blingContactId
    ? await getBlingContact(deps, contact.blingContactId, client)
    : await findBlingContact(deps, { document: contact.document, phone: contact.phone }, client);
  if (!found) return { contact, bling: null };
  const blingId = String(found.id);
  const other = await deps.db.contact.findFirst({ where: { blingContactId: blingId, id: { not: contact.id } } });
  const updated = await deps.db.contact.update({
    where: { id: contact.id },
    data: {
      blingContactId: other ? contact.blingContactId : blingId,
      name: contact.name ?? (found.nome?.trim() || null),
      email: contact.email ?? (found.email?.trim() || null),
      document: contact.document ?? (onlyDigits(found.numeroDocumento) || null),
    },
  });
  return { contact: updated, bling: found, conflict: other ? other.id : undefined };
}
