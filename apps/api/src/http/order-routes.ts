import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { normalizePhone } from '../lib/phone.js';
import {
  getOrderConfig,
  getPollState,
  GROUP_LABEL,
  KIND_INFO,
  ORDER_KINDS,
  saveOrderConfig,
  SITUATION_GROUPS,
  situationsByName,
  TIKTOK_STORE_ID,
  type OrderNoticeConfig,
} from '../orders/config.js';
import { listSaleSituations, pollOrders, sendTestNotice } from '../orders/engine.js';
import { createTemplate } from '../templates/service.js';
import { badRequest, HttpError, parse } from './errors.js';

function requireAdmin(req: FastifyRequest) {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador muda os avisos de pedido.');
}

const kindEnum = z.enum(ORDER_KINDS);
const configSchema = z.object({
  enabled: z.boolean(),
  testPhone: z.string().trim().max(30).nullable(),
  excludedStores: z.array(z.string().regex(/^\d+$/)).max(50),
  onlyAfterFlow: z.boolean(),
  storeInfo: z.string().trim().max(300),
  trackingUrl: z.string().trim().url('link de rastreio inválido').max(300),
  phoneNumberId: z.string().nullable(),
  situations: z.object(Object.fromEntries(SITUATION_GROUPS.map((g) => [g, z.array(z.number().int().positive()).max(10)])) as Record<(typeof SITUATION_GROUPS)[number], z.ZodArray<z.ZodNumber>>),
  kinds: z.object(
    Object.fromEntries(ORDER_KINDS.map((k) => [k, z.object({ enabled: z.boolean(), template: z.string().trim().regex(/^[a-z0-9_]+$/, 'nome de template inválido') })])) as Record<
      (typeof ORDER_KINDS)[number],
      z.ZodObject<{ enabled: z.ZodBoolean; template: z.ZodString }>
    >,
  ),
});

export async function orderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/order-notices', async () => {
    const [cfg, state, numbers, templates, stores, blingAuth] = await Promise.all([
      getOrderConfig(deps.db),
      getPollState(deps.db),
      deps.db.phoneNumber.findMany({ where: { isActive: true }, select: { id: true, displayName: true, displayPhone: true, role: true, wabaId: true }, orderBy: { createdAt: 'asc' } }),
      deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, select: { id: true, name: true, status: true, category: true, wabaId: true, rejectedReason: true }, orderBy: { name: 'asc' } }),
      deps.db.orderState.groupBy({ by: ['lojaId'], _count: { _all: true } }),
      deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }),
    ]);
    let situations: { id: number; nome: string }[] = [];
    let situationsError: string | null = null;
    if (blingAuth) {
      try {
        situations = await listSaleSituations(deps);
      } catch (err) {
        situationsError = (err as Error).message;
      }
    }
    const config: OrderNoticeConfig = !cfg.saved && situations.length ? { ...cfg, situations: situationsByName(situations) } : cfg;
    return {
      config,
      state,
      blingConnected: Boolean(blingAuth),
      situations,
      situationsError,
      groups: SITUATION_GROUPS.map((g) => ({ key: g, label: GROUP_LABEL[g] })),
      kinds: ORDER_KINDS.map((k) => ({ key: k, ...KIND_INFO[k] })),
      templates,
      numbers,
      stores: stores
        .filter((s) => s.lojaId)
        .map((s) => ({ id: s.lojaId!, orders: s._count._all, tiktok: s.lojaId === TIKTOK_STORE_ID }))
        .sort((a, b) => b.orders - a.orders),
      tiktokStoreId: TIKTOK_STORE_ID,
    };
  });

  app.put('/order-notices', async (req) => {
    requireAdmin(req);
    const body = parse(configSchema, req.body);
    if (body.testPhone && !normalizePhone(body.testPhone)) throw badRequest('Número de teste inválido. Use DDD + número, ex.: 63 99214-2094.');
    if (body.enabled) {
      const empty = SITUATION_GROUPS.filter((g) => body.situations[g].length === 0 && g !== 'ETIQUETA');
      if (empty.length) throw badRequest(`Escolha a situação do Bling de: ${empty.map((g) => GROUP_LABEL[g]).join(', ')}.`);
      if (body.kinds.PRONTO_RETIRAR.enabled && !body.storeInfo) throw badRequest('Preencha o endereço e horário da loja (usado em "pronto para retirar").');
    }
    await saveOrderConfig(deps.db, { ...body, testPhone: body.testPhone || null, saved: true });
    return { config: await getOrderConfig(deps.db) };
  });

  /** Cria na Meta os templates sugeridos que ainda não existem (categoria Utilidade). */
  app.post('/order-notices/templates', async (req) => {
    requireAdmin(req);
    const cfg = await getOrderConfig(deps.db);
    const results: { kind: string; name: string; status: string; error?: string }[] = [];
    for (const k of ORDER_KINDS) {
      const s = KIND_INFO[k].suggested;
      const name = cfg.kinds[k].template || s.name;
      const existing = await deps.db.template.findFirst({ where: { name, status: { not: 'DELETED' } } });
      if (existing) {
        results.push({ kind: k, name, status: existing.status });
        continue;
      }
      try {
        const row = await createTemplate(deps, {
          name,
          language: 'pt_BR',
          category: 'UTILITY',
          body: s.body,
          bodyExamples: s.examples,
          footer: 'Oliver Cosméticos',
          quickReplies: [],
          addOptOutButton: false,
        });
        results.push({ kind: k, name, status: row.status });
      } catch (err) {
        results.push({ kind: k, name, status: 'ERRO', error: (err as Error).message });
      }
    }
    return { results };
  });

  app.post('/order-notices/poll', async () => pollOrders(deps));

  app.post('/order-notices/test', async (req) => {
    const body = parse(z.object({ kind: kindEnum, orderNumber: z.coerce.number().int().positive('informe o nº do pedido') }), req.body);
    try {
      return await sendTestNotice(deps, body.kind, body.orderNumber);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest((err as Error).message);
    }
  });

  app.get('/order-notices/log', async (req) => {
    const q = parse(
      z.object({ status: z.enum(['SENT', 'SKIPPED', 'FAILED']).optional(), search: z.string().trim().max(60).optional(), take: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    const num = q.search && /^\d+$/.test(q.search) ? Number(q.search) : null;
    const rows = await deps.db.orderNotice.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.search ? (num ? { orderNumber: num } : { customerName: { contains: q.search, mode: 'insensitive' } }) : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: q.take,
    });
    const counts = await deps.db.orderNotice.groupBy({ by: ['status'], where: { updatedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } });
    return {
      notices: rows,
      last7days: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  });
}
