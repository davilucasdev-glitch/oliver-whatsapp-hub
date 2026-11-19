import { blingClient, BlingApiError, type BlingClient } from '../bling/client.js';
import { getBlingContact, getOrderDetail } from '../bling/orders.js';
import type { BlingBordero, BlingOne, BlingPage, BlingReceivable } from '../bling/types.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { resolvePhone } from '../orders/engine.js';
import { addDays, getChargeConfig, getChargeSyncState, money, saveChargeSyncState, spDate } from './config.js';

/**
 * Copia as contas a receber do Bling para a tabela Receivable:
 *  - em aberto e parcialmente recebidas, emitidas a partir do corte (01/10/2026);
 *  - recebidas nos últimos 10 dias (para o "pagamento recebido").
 * Para cada conta nova busca uma vez a loja do pedido (TikTok fica de fora) e o telefone
 * (WhatsApp gravado pelo site no pedido ou celular do contato).
 * Percebe pagamentos novos comparando quanto faltava com quanto falta agora.
 */

const log = childLogger('cobranca:sync');
const MAX_PAGES = 50;
const RECEIVED_WINDOW_DAYS = 10;

async function listAll(client: BlingClient, query: Record<string, string | number | (string | number)[]>): Promise<BlingReceivable[]> {
  const out: BlingReceivable[] = [];
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const res = await client.get<BlingPage<BlingReceivable>>('/contas/receber', { ...query, limite: 100, pagina });
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

async function getReceivable(client: BlingClient, id: number | string): Promise<BlingReceivable | null> {
  try {
    return (await client.get<BlingOne<BlingReceivable>>(`/contas/receber/${id}`)).data;
  } catch (err) {
    if (err instanceof BlingApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Quanto falta numa conta parcialmente paga. O Bling não documenta um campo de saldo, então:
 * 1) "saldo" no detalhe, se vier; 2) soma dos borderôs (baixas) da conta; 3) desconhecido.
 */
export async function partialRemaining(client: BlingClient, r: BlingReceivable): Promise<number | null> {
  const detail = await getReceivable(client, r.id);
  if (!detail) return null;
  if (typeof detail.saldo === 'number' && detail.saldo >= 0) return money(detail.saldo);
  const ids = (detail.borderos ?? []).map((b) => (typeof b === 'number' ? b : b.id)).filter(Boolean);
  if (!ids.length) return null;
  let paid = 0;
  for (const id of ids) {
    const b = await client.get<BlingOne<BlingBordero>>(`/borderos/${id}`).then((x) => x.data).catch(() => null);
    if (!b?.pagamentos?.length) return null;
    // um borderô pode baixar várias contas do mesmo cliente; sem como separar, não chuta
    if (b.pagamentos.length > 1) return null;
    paid += b.pagamentos[0]!.valorPago;
  }
  return money(Math.max(0, detail.valor - paid));
}

export interface ChargeSyncResult {
  open: number;
  received: number;
  newPayments: number;
  unknownRemaining: number;
}

export async function syncReceivables(deps: Deps, now = new Date()): Promise<ChargeSyncResult> {
  const cfg = await getChargeConfig(deps.db);
  const st = await getChargeSyncState(deps.db);
  const client = blingClient(deps);
  const today = spDate(now);
  try {
    const open = await listAll(client, { situacoes: [1, 3], tipoFiltroData: 'E', dataInicial: cfg.cutoff, dataFinal: today });
    const received = await listAll(client, { situacoes: [2], tipoFiltroData: 'R', dataInicial: addDays(today, -RECEIVED_WINDOW_DAYS), dataFinal: today });
    const seen = new Map<string, BlingReceivable>();
    for (const r of [...received, ...open]) if (r.dataEmissao >= cfg.cutoff) seen.set(String(r.id), r);

    // contas que estavam abertas e sumiram das duas listas: confere uma a uma (cancelada, devolvida, recebida há mais tempo)
    const gone = await deps.db.receivable.findMany({ where: { situacao: { in: [1, 3] }, blingId: { notIn: [...seen.keys()] } } });
    for (const g of gone) {
      const d = await getReceivable(client, g.blingId);
      if (d) seen.set(g.blingId, d);
      else await deps.db.receivable.delete({ where: { blingId: g.blingId } });
    }

    const contactPhones = new Map<string, string | null>();
    let newPayments = 0;
    let unknown = 0;
    for (const [id, r] of seen) {
      const prev = await deps.db.receivable.findUnique({ where: { blingId: id } });
      let remaining = r.situacao === 1 ? r.valor : r.situacao === 3 ? null : 0;
      if (r.situacao === 3) {
        remaining = await partialRemaining(client, r);
        if (remaining === null) unknown++;
      }
      const known = remaining !== null;
      const rem = money(remaining ?? r.valor);

      // pagamento novo: falta menos do que faltava (ou foi recebida inteira)
      let payment: { amount: number } | null = null;
      if (prev && known && prev.remainingKnown && rem < prev.remaining - 0.009) payment = { amount: money(prev.remaining - rem) };
      if (prev && r.situacao === 2 && prev.situacao !== 2 && !payment) payment = { amount: money(prev.remainingKnown ? prev.remaining : r.valor) };
      if (!prev && r.situacao === 2) payment = { amount: money(r.valor) }; // recebida nos últimos dias, vista agora pela primeira vez
      if (payment) newPayments++;

      // loja e telefone: uma vez por conta (o pedido e o cadastro não mudam de loja)
      let extra: { lojaId: string | null; orderBlingId: string | null; orderNumber: string | null; phone: string | null; phoneSource: string | null } | null = null;
      if (!prev?.resolvedAt) {
        const orderId = r.origem?.id || r.idOrigem || null;
        const isSale = !r.origem?.tipoOrigem || r.origem.tipoOrigem === 'venda';
        const order = orderId && isSale ? await getOrderDetail(deps, orderId, client).catch(() => null) : null;
        let phone: string | null = null;
        let source: string | null = null;
        if (order) {
          phone = await resolvePhone(deps, client, order);
          source = phone ? 'pedido' : null;
        }
        if (!phone) {
          const key = String(r.contato.id);
          if (!contactPhones.has(key)) {
            const c = await getBlingContact(deps, key, client).catch(() => null);
            const p = [c?.celular, c?.telefone].map((x) => (x ? normalizePhone(x) : null)).find(Boolean) ?? null;
            contactPhones.set(key, p);
          }
          phone = contactPhones.get(key) ?? null;
          source = phone ? 'contato' : null;
        }
        extra = {
          lojaId: order?.loja?.id ? String(order.loja.id) : null,
          orderBlingId: orderId ? String(orderId) : null,
          orderNumber: order ? String(order.numero) : (r.origem?.numero ?? null) || null,
          phone,
          phoneSource: source,
        };
      }

      const data = {
        contactBlingId: String(r.contato.id),
        contactName: r.contato.nome?.trim() || 'cliente',
        valor: money(r.valor),
        remaining: rem,
        remainingKnown: known,
        vencimento: r.vencimento,
        emissao: r.dataEmissao,
        situacao: r.situacao,
        seenAt: now,
        ...(extra ? { ...extra, resolvedAt: now } : {}),
        ...(payment ? { lastPaymentAmount: payment.amount, lastPaymentAt: now, paymentSeq: (prev?.paymentSeq ?? 0) + 1 } : {}),
      };
      await deps.db.receivable.upsert({ where: { blingId: id }, create: { blingId: id, ...data }, update: data });
    }

    const openCount = [...seen.values()].filter((r) => r.situacao === 1 || r.situacao === 3).length;
    await saveChargeSyncState(deps.db, { lastSyncAt: now.toISOString(), lastError: null, open: openCount, unknownRemaining: unknown });
    log.info({ abertas: openCount, recebidas: received.length, pagamentosNovos: newPayments }, 'Contas a receber sincronizadas');
    return { open: openCount, received: received.length, newPayments, unknownRemaining: unknown };
  } catch (err) {
    const msg = `Erro ao ler contas a receber do Bling: ${(err as Error).message}`.slice(0, 300);
    await saveChargeSyncState(deps.db, { ...st, lastError: msg });
    throw new Error(msg, { cause: err });
  }
}
