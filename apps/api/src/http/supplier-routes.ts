import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Agent } from '../inbox/service.js';
import { purchaseOrderPdf } from '../suppliers/pdf.js';
import {
  clearPurchaseOrderCache,
  createSupplierTemplates,
  getSupplierConfig,
  listPurchaseOrders,
  purchaseOrderForPdf,
  saveSupplierConfig,
  searchSuppliers,
  sendPurchaseOrder,
  sendQuote,
  SUPPLIER_INFO,
  SUPPLIER_KINDS,
  supplierContact,
} from '../suppliers/service.js';
import { blingHttpError } from './bling-routes.js';
import { badRequest, HttpError, parse } from './errors.js';

const agent = (req: FastifyRequest): Agent => ({ id: req.user!.id, name: req.user!.name || req.user!.email.split('@')[0]! });
const requireAdmin = (req: FastifyRequest) => {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador muda essas configurações.');
};

async function bling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return blingHttpError(err);
  }
}

export async function supplierRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/suppliers', async (req) => {
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    const [config, templates, history, connected] = await Promise.all([
      getSupplierConfig(deps.db),
      deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, select: { name: true, status: true, rejectedReason: true } }),
      deps.db.supplierSend.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
      deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }),
    ]);
    let orders: Awaited<ReturnType<typeof listPurchaseOrders>> = [];
    let blingError: string | null = null;
    if (connected) {
      try {
        orders = await bling(() => listPurchaseOrders(deps, refresh));
      } catch (err) {
        blingError = (err as Error).message;
      }
    }
    const users = new Map((await deps.db.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email.split('@')[0]!]));
    return {
      connected: Boolean(connected),
      blingError,
      orders,
      config,
      appIdSet: Boolean(deps.env.META_APP_ID),
      kinds: SUPPLIER_KINDS.map((k) => ({ key: k, ...SUPPLIER_INFO[k], template: templates.find((t) => t.name === config.templates[k]) ?? null })),
      history: history.map((h) => ({ ...h, sentBy: h.sentByUserId ? (users.get(h.sentByUserId) ?? null) : null })),
    };
  });

  /** O PDF que vai para o fornecedor (para conferir antes de mandar). */
  app.get('/suppliers/purchase-orders/:id/pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { pdf } = await bling(() => purchaseOrderForPdf(deps, id));
    const file = await purchaseOrderPdf(pdf);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="pedido-compra-${pdf.numero}.pdf"`).send(file);
  });

  app.post('/suppliers/purchase-orders/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    const r = await bling(() => sendPurchaseOrder(deps, agent(req), id));
    clearPurchaseOrderCache();
    return r;
  });

  app.get('/suppliers/search', async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2, 'digite pelo menos 2 letras').max(60) }), req.query);
    return { suppliers: await bling(() => searchSuppliers(deps, q)) };
  });

  app.get('/suppliers/contact/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { supplier: await bling(() => supplierContact(deps, id)) };
  });

  /** Cotação: PDF (do compras.php) + fornecedor do Bling ou WhatsApp digitado. */
  app.post('/suppliers/quote', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Envie o PDF da cotação.');
    const data = await file.toBuffer().catch(() => {
      throw badRequest('Arquivo acima de 16 MB.');
    });
    const field = (n: string) => {
      const f = file.fields[n] as { value?: unknown } | undefined;
      return typeof f?.value === 'string' && f.value.trim() ? f.value.trim() : null;
    };
    return bling(() => sendQuote(deps, agent(req), { pdf: data, filename: file.filename || 'Cotacao Oliver Cosmeticos.pdf', supplierBlingId: field('supplierBlingId'), phone: field('phone'), name: field('name') }));
  });

  app.put('/suppliers/config', async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        ownerUserId: z.string().nullable(),
        phoneNumberId: z.string().nullable(),
        templates: z.object({ PEDIDO_COMPRA: z.string().trim().regex(/^[a-z0-9_]+$/), COTACAO: z.string().trim().regex(/^[a-z0-9_]+$/) }),
      }),
      req.body,
    );
    await saveSupplierConfig(deps.db, body);
    return { config: await getSupplierConfig(deps.db) };
  });

  app.post('/suppliers/templates', async (req) => {
    requireAdmin(req);
    return { results: await createSupplierTemplates(deps) };
  });
}
