import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { blingConfigured, blingRedirectUri, buildAuthorizeUrl, BlingApiError, BlingNotConnectedError, exchangeCode, saveTokens } from '../bling/client.js';
import { enqueueProductSync } from '../bling/jobs.js';
import { linkContactToBling, listContactOrders } from '../bling/orders.js';
import { productCategories, searchProducts } from '../bling/products.js';
import { getSyncStatus } from '../bling/sync.js';
import type { Deps } from '../deps.js';
import { sha256 } from '../lib/crypto.js';
import { childLogger } from '../lib/logger.js';
import { getSetting, setSetting } from '../settings.js';
import { HttpError, notFound, parse } from './errors.js';

const log = childLogger('bling:routes');
const STATE_KEY = 'bling.oauthState';
const STATE_TTL_MS = 10 * 60_000;

/** Converte erros do Bling em respostas legíveis no painel. */
export function blingHttpError(err: unknown): never {
  if (err instanceof BlingNotConnectedError) throw new HttpError(409, err.message);
  if (err instanceof BlingApiError) throw new HttpError(502, `Bling: ${err.message}`);
  throw err;
}

/**
 * Rota pública: o Bling redireciona o navegador para cá depois da autorização.
 * O cookie de sessão (SameSite=Strict) não vem nesse redirecionamento entre sites, então quem
 * protege é o "state": aleatório, de uso único, válido por 10 min e criado por um usuário logado.
 */
export async function blingPublicRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const panel = deps.env.PANEL_URL.replace(/\/$/, '');
  app.get('/bling/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (params: Record<string, string>) => reply.redirect(`${panel}/produtos?${new URLSearchParams(params).toString()}`);

    const saved = await getSetting<{ hash: string; expiresAt: string } | null>(deps.db, STATE_KEY, null);
    if (!q.state || !saved || saved.hash !== sha256(q.state) || Date.parse(saved.expiresAt) < Date.now()) {
      return back({ bling: 'erro', motivo: 'Link de autorização inválido ou expirado. Clique em "Conectar Bling" de novo.' });
    }
    await setSetting(deps.db, STATE_KEY, null); // uso único
    if (q.error || !q.code) {
      return back({ bling: 'erro', motivo: q.error_description || 'A autorização foi cancelada no Bling.' });
    }
    try {
      const tokens = await exchangeCode(deps.env, q.code);
      await saveTokens(deps, tokens, 'connect');
      await deps.db.alert.updateMany({ where: { type: 'BLING_DISCONNECTED', readAt: null }, data: { readAt: new Date() } });
      await enqueueProductSync(deps, { trigger: 'conexao' });
      log.info('Bling conectado');
      return back({ bling: 'conectado' });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Falha ao trocar o código do Bling');
      return back({ bling: 'erro', motivo: `O Bling recusou a conexão: ${(err as Error).message}` });
    }
  });
}

const productQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(200).optional(),
  gender: z.enum(['feminino', 'masculino', 'unissex', 'infantil']).optional(),
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

export async function blingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/bling/status', async () => {
    const [auth, sync, total, active, inStock] = await Promise.all([
      deps.db.blingAuth.findUnique({ where: { id: 'default' } }),
      getSyncStatus(deps),
      deps.db.product.count(),
      deps.db.product.count({ where: { active: true } }),
      deps.db.product.count({ where: { active: true, stock: { gt: 0 } } }),
    ]);
    return {
      configured: blingConfigured(deps.env),
      connected: Boolean(auth),
      connectedAt: auth?.connectedAt ?? null,
      tokenExpiresAt: auth?.expiresAt ?? null,
      lastRefreshAt: auth?.lastRefreshAt ?? null,
      redirectUri: blingRedirectUri(deps.env),
      intervalMinutes: deps.env.BLING_SYNC_INTERVAL_MINUTES,
      sync,
      products: { total, active, inStock },
    };
  });

  app.post('/bling/connect', async () => {
    if (!blingConfigured(deps.env)) {
      throw new HttpError(409, 'Preencha BLING_CLIENT_ID e BLING_CLIENT_SECRET no .env e reinicie a API.');
    }
    const state = randomBytes(24).toString('base64url');
    await setSetting(deps.db, STATE_KEY, { hash: sha256(state), expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() });
    return { url: buildAuthorizeUrl(deps.env, state) };
  });

  app.post('/bling/disconnect', async () => {
    await deps.db.blingAuth.deleteMany({});
    return { ok: true };
  });

  app.post('/bling/sync', async (req) => {
    const { full } = parse(z.object({ full: z.boolean().default(false) }), req.body ?? {});
    const auth = await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } });
    if (!auth) throw new HttpError(409, 'Conecte o Bling antes de sincronizar.');
    const status = await getSyncStatus(deps);
    if (status.running && status.startedAt && Date.now() - Date.parse(status.startedAt) < 30 * 60_000) {
      throw new HttpError(409, 'Já existe uma sincronização em andamento.');
    }
    await enqueueProductSync(deps, { full, trigger: 'manual' });
    return { queued: true };
  });

  // ── Produtos (cópia local do catálogo do Bling) ──
  app.get('/products', async (req) => {
    const q = parse(productQuery, req.query);
    const { products, total } = await searchProducts(deps.db, {
      query: q.q,
      category: q.category,
      gender: q.gender,
      inStock: q.inStock,
      includeInactive: q.includeInactive,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    });
    return { products, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/products/categories', async () => ({ categories: await productCategories(deps.db) }));

  app.get('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = await deps.db.product.findUnique({ where: { id } });
    if (!p) throw notFound('Produto não encontrado');
    const { searchText: _s, listHash: _h, ...rest } = p;
    return { product: { ...rest, price: Number(p.price), stock: Number(p.stock) } };
  });

  // ── Contato ↔ Bling ──
  app.get('/contacts/:id/bling', async (req) => {
    const { id } = req.params as { id: string };
    try {
      const linked = await linkContactToBling(deps, id);
      if (!linked) throw notFound('Contato não encontrado');
      if (!linked.bling) {
        return { linked: false, blingContact: null, orders: [], hint: linked.contact.document ? 'Nenhum cadastro no Bling com este CPF/CNPJ ou telefone.' : 'Nenhum cadastro no Bling com este telefone. Informe o CPF/CNPJ no contato para buscar por ele.' };
      }
      const orders = await listContactOrders(deps, String(linked.bling.id), 5);
      return {
        linked: !linked.conflict,
        conflictContactId: linked.conflict ?? null,
        blingContact: { id: String(linked.bling.id), nome: linked.bling.nome, numeroDocumento: linked.bling.numeroDocumento ?? null },
        orders,
      };
    } catch (err) {
      return blingHttpError(err);
    }
  });
}
