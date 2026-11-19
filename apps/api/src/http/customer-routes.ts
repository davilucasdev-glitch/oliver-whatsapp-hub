import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { blingClient } from '../bling/client.js';
import { getBlingContact, linkContactToBling, listContactOrders, samePhone, type OrderSummary } from '../bling/orders.js';
import { getChargeConfig, getChargeSyncState, money, spDate, TIKTOK_STORE_ID } from '../charges/config.js';
import type { Deps } from '../deps.js';
import { getSetting, setSetting } from '../settings.js';
import { blingHttpError } from './bling-routes.js';
import { notFound, parse } from './errors.js';

/**
 * Ficha da cliente na Inbox (documento da Ellen, "Atendimento"): quem é no Bling, últimos
 * pedidos, o pedido em andamento e o saldo em aberto no crediário.
 * - Cadastro: pelo vínculo já salvo, pelo telefone nas contas a receber copiadas (sem chamar o
 *   Bling) ou pela busca no Bling (CPF/CNPJ ou telefone).
 * - Pedidos: consulta ao vivo, guardada 2 minutos por cliente (cada pedido é uma chamada).
 * - Crediário: da cópia das contas a receber (mesmas regras da tela Cobrança).
 */

const ORDERS_TTL_MS = 2 * 60_000;
const ordersCache = new Map<string, { at: number; orders: OrderSummary[] }>();
const KANBAN_KEY = 'inbox.kanbanUrl';

const FINAL = /atendido|cancelad|entregue|devolvid/i;

export async function customerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/conversations/:id/customer', async (req) => {
    const { id } = req.params as { id: string };
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    const conv = await deps.db.conversation.findUnique({ where: { id }, include: { contact: true } });
    if (!conv) throw notFound('Conversa não encontrada');
    let contact = conv.contact;
    const connected = Boolean(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }));
    const kanbanUrl = await getSetting<string>(deps.db, KANBAN_KEY, '');

    // 1) vínculo pelo telefone das contas a receber já copiadas (de graça)
    if (!contact.blingContactId) {
      const recs = await deps.db.receivable.findMany({ where: { phone: { not: null } }, select: { phone: true, contactBlingId: true }, distinct: ['contactBlingId'] });
      const hit = recs.find((r) => samePhone(r.phone, contact.phone));
      if (hit && !(await deps.db.contact.findUnique({ where: { blingContactId: hit.contactBlingId } }))) {
        contact = await deps.db.contact.update({ where: { id: contact.id }, data: { blingContactId: hit.contactBlingId } });
      }
    }

    let bling: { id: string; nome: string; numeroDocumento: string | null } | null = null;
    let orders: OrderSummary[] = [];
    let blingError: string | null = null;
    let hint: string | null = null;
    if (connected) {
      try {
        const client = blingClient(deps);
        if (!contact.blingContactId) {
          // 2) busca no Bling por CPF/CNPJ ou telefone (e completa nome/e-mail/CPF vazios)
          const linked = await linkContactToBling(deps, contact.id, client);
          if (linked?.contact) contact = linked.contact;
          if (linked?.bling) bling = { id: String(linked.bling.id), nome: linked.bling.nome, numeroDocumento: linked.bling.numeroDocumento ?? null };
          else hint = contact.document ? 'Nenhum cadastro no Bling com este CPF/CNPJ ou telefone.' : 'Nenhum cadastro no Bling com este telefone. Peça o CPF e informe na ficha do contato.';
        }
        if (contact.blingContactId) {
          if (!bling) {
            const c = await getBlingContact(deps, contact.blingContactId, client);
            if (c) bling = { id: String(c.id), nome: c.nome, numeroDocumento: c.numeroDocumento ?? null };
          }
          const cached = ordersCache.get(contact.blingContactId);
          if (cached && !refresh && Date.now() - cached.at < ORDERS_TTL_MS) orders = cached.orders;
          else {
            orders = await listContactOrders(deps, contact.blingContactId, 3, client);
            ordersCache.set(contact.blingContactId, { at: Date.now(), orders });
          }
        }
      } catch (err) {
        try {
          blingHttpError(err);
        } catch (e) {
          blingError = (e as Error).message;
        }
      }
    }

    // crediário (cópia sincronizada; mesmas regras da Cobrança)
    let credit = null;
    if (contact.blingContactId) {
      const cfg = await getChargeConfig(deps.db);
      const today = spDate();
      const recs = (await deps.db.receivable.findMany({ where: { contactBlingId: contact.blingContactId, situacao: { in: [1, 3] } }, orderBy: { vencimento: 'asc' } })).filter(
        (r) => r.emissao >= cfg.cutoff && r.lojaId !== TIKTOK_STORE_ID && r.remaining > 0.009,
      );
      const overdue = recs.filter((r) => r.vencimento < today);
      const last = await deps.db.chargeNotice.findFirst({ where: { contactBlingId: contact.blingContactId, status: 'SENT' }, orderBy: { createdAt: 'desc' } });
      const sync = await getChargeSyncState(deps.db);
      credit = {
        balance: money(recs.reduce((a, r) => a + r.remaining, 0)),
        balanceKnown: recs.every((r) => r.remainingKnown),
        overdue: money(overdue.reduce((a, r) => a + r.remaining, 0)),
        oldestDue: overdue[0]?.vencimento ?? null,
        parcels: recs.slice(0, 8).map((r) => ({ vencimento: r.vencimento, remaining: r.remaining, known: r.remainingKnown, orderNumber: r.orderNumber, late: r.vencimento < today })),
        more: Math.max(0, recs.length - 8),
        lastCharge: last ? { kind: last.kind, at: last.createdAt } : null,
        syncedAt: sync.lastSyncAt,
      };
    }

    return {
      contact: { id: contact.id, name: contact.name, phone: contact.phone, document: contact.document, blingContactId: contact.blingContactId },
      connected,
      bling,
      hint,
      blingError,
      orders,
      openOrder: orders.find((o) => !FINAL.test(o.situacao)) ?? null,
      credit,
      kanbanUrl: kanbanUrl || null,
    };
  });

  /** Link do Kanban do painel (ex.: https://painel.../kanban.php?pedido={numero}). */
  app.put('/inbox/kanban-url', async (req) => {
    const { url } = parse(z.object({ url: z.string().trim().max(300).refine((u) => !u || (/^https?:\/\//.test(u) && u.includes('{numero}')), 'use um link https com {numero}') }), req.body);
    await setSetting(deps.db, KANBAN_KEY, url);
    return { url };
  });
}
