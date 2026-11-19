import type { Prisma } from '@prisma/client';
import type { Deps } from '../deps.js';
import { sha256 } from '../lib/crypto.js';
import { childLogger } from '../lib/logger.js';
import { getSetting, setSetting } from '../settings.js';
import { BlingNotConnectedError, blingClient, type BlingClient } from './client.js';
import { detectGender, firstSentence, htmlToText, normalizeSearch } from './html.js';
import type { BlingCategory, BlingListProduct, BlingOne, BlingPage, BlingProductDetail } from './types.js';

const log = childLogger('bling:sync');

export const BLING_SYNC_STATUS_KEY = 'bling.syncStatus';
const PAGE_SIZE = 100;
const MAX_PAGES = 300; // trava de segurança (30 mil produtos)
const DETAIL_MAX_AGE_MS = 7 * 24 * 3600_000; // detalhe (categoria) é revisto pelo menos 1x por semana
const STALE_LOCK_MS = 30 * 60_000;

export interface SyncResult {
  listed: number;
  created: number;
  updated: number;
  details: number;
  deactivated: number;
  calls: number;
  ms: number;
}

export interface SyncStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  ok?: boolean;
  error?: string;
  trigger?: string;
  result?: SyncResult;
}

type SyncDeps = Pick<Deps, 'env' | 'db'>;

export interface SyncOptions {
  client?: BlingClient;
  /** busca o detalhe de todos os produtos, mesmo sem mudança */
  full?: boolean;
  /** limite de detalhes por execução (o restante fica para a próxima) */
  maxDetails?: number;
  trigger?: string;
}

export async function getSyncStatus(deps: SyncDeps): Promise<SyncStatus> {
  return getSetting<SyncStatus>(deps.db, BLING_SYNC_STATUS_KEY, { running: false });
}

async function fetchAllPages<T>(client: BlingClient, path: string, query: Record<string, string | number> = {}): Promise<T[]> {
  const all: T[] = [];
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const page = await client.get<BlingPage<T>>(path, { ...query, pagina, limite: PAGE_SIZE });
    const items = page?.data ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) return all;
  }
  throw new Error(`Mais de ${MAX_PAGES} páginas em ${path}; verifique o filtro`);
}

/** id da categoria → "Pai > Filha" */
export function categoryPaths(categories: BlingCategory[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const paths = new Map<string, string>();
  for (const c of categories) {
    const names: string[] = [];
    let cur: BlingCategory | undefined = c;
    const seen = new Set<string>();
    while (cur && !seen.has(String(cur.id))) {
      seen.add(String(cur.id));
      names.unshift(cur.descricao.trim());
      const parentId: number | undefined = cur.categoriaPai?.id;
      cur = parentId ? byId.get(String(parentId)) : undefined;
    }
    paths.set(String(c.id), names.join(' > '));
  }
  return paths;
}

function listHash(p: BlingListProduct): string {
  return sha256(JSON.stringify([p.nome, p.codigo ?? '', p.preco ?? 0, p.descricaoCurta ?? '', p.formato ?? '', p.idProdutoPai ?? 0]));
}

export function buildSearchText(parts: { name: string; sku?: string | null; category?: string | null; text?: string | null }): string {
  return normalizeSearch([parts.name, parts.sku ?? '', parts.category ?? '', (parts.text ?? '').slice(0, 3000)].join(' '));
}

/** Campos derivados do texto (descrição limpa, resumo, gênero, busca). */
function derived(name: string, sku: string | null, html: string, extraHtml: string | undefined, category: string | null) {
  let text = htmlToText(html);
  if (!text && extraHtml) text = htmlToText(extraHtml);
  return {
    descriptionText: text || null,
    shortDescription: text ? firstSentence(text) : null,
    gender: detectGender(text, category, name),
    searchText: buildSearchText({ name, sku, category, text }),
  };
}

export async function syncProducts(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const { db } = deps;
  const status = await getSyncStatus(deps);
  if (status.running && status.startedAt && Date.now() - Date.parse(status.startedAt) < STALE_LOCK_MS) {
    throw new Error('Já existe uma sincronização em andamento.');
  }
  const client = opts.client ?? blingClient(deps);
  const startedAt = new Date();
  const callsBefore = client.calls;
  await setSetting(db, BLING_SYNC_STATUS_KEY, { ...status, running: true, startedAt: startedAt.toISOString(), trigger: opts.trigger });

  try {
    const result = await runSync(deps, client, startedAt, opts);
    result.calls = client.calls - callsBefore;
    await setSetting(db, BLING_SYNC_STATUS_KEY, {
      running: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ok: true,
      trigger: opts.trigger,
      result,
    } satisfies SyncStatus);
    log.info(result, 'Sync de produtos do Bling concluído');
    return result;
  } catch (err) {
    const message = err instanceof BlingNotConnectedError ? err.message : `Falha no sync: ${(err as Error).message}`;
    await setSetting(db, BLING_SYNC_STATUS_KEY, {
      running: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      error: message,
      trigger: opts.trigger,
      result: status.result,
    } satisfies SyncStatus);
    log.error({ err: (err as Error).message }, 'Sync de produtos do Bling falhou');
    throw err;
  }
}

async function runSync(deps: SyncDeps, client: BlingClient, startedAt: Date, opts: SyncOptions): Promise<SyncResult> {
  const { db } = deps;
  const t0 = Date.now();
  const result: SyncResult = { listed: 0, created: 0, updated: 0, details: 0, deactivated: 0, calls: 0, ms: 0 };

  const categories = categoryPaths(await fetchAllPages<BlingCategory>(client, '/categorias/produtos'));
  // criterio=2 → só ativos. Quem sumir da lista é marcado como inativo no fim.
  const listed = await fetchAllPages<BlingListProduct>(client, '/produtos', { criterio: 2 });
  result.listed = listed.length;

  const existing = new Map(
    (
      await db.product.findMany({
        select: {
          blingId: true,
          listHash: true,
          detailSyncedAt: true,
          category: true,
          categoryId: true,
          descriptionHtml: true,
          stock: true,
          active: true,
        },
      })
    ).map((p) => [p.blingId, p]),
  );

  let detailBudget = opts.maxDetails ?? 2000;
  for (const item of listed) {
    if (item.tipo === 'S') continue; // serviços não são vendidos pelo bot
    const blingId = String(item.id);
    const prev = existing.get(blingId);
    const hash = listHash(item);
    const sku = item.codigo?.trim() || null;
    const html = item.descricaoCurta ?? '';

    const needsDetail =
      opts.full ||
      !prev ||
      prev.listHash !== hash ||
      !prev.detailSyncedAt ||
      Date.now() - prev.detailSyncedAt.getTime() > DETAIL_MAX_AGE_MS;

    let detail: BlingProductDetail | undefined;
    if (needsDetail && detailBudget > 0) {
      detailBudget--;
      detail = (await client.get<BlingOne<BlingProductDetail>>(`/produtos/${item.id}`)).data;
      result.details++;
    }

    const categoryId = detail ? (detail.categoria?.id ? String(detail.categoria.id) : null) : (prev?.categoryId ?? null);
    const category = categoryId ? (categories.get(categoryId) ?? prev?.category ?? null) : null;
    // Sem descricaoCurta, a descrição vem da complementar (só existe no detalhe): sem detalhe novo, mantém a que já temos.
    const extraHtml = html ? undefined : (detail?.descricaoComplementar ?? prev?.descriptionHtml ?? undefined);
    const stock = item.estoque?.saldoVirtualTotal ?? 0;
    const active = item.situacao !== 'I';
    const base = {
      name: item.nome.trim(),
      sku,
      parentBlingId: item.idProdutoPai ? String(item.idProdutoPai) : null,
      price: (item.preco ?? 0).toFixed(2),
      stock: String(stock),
      format: item.formato ?? null,
      imageUrl: item.imagemURL || null,
      descriptionHtml: html || extraHtml || null,
      categoryId,
      category,
      active,
      syncedAt: startedAt,
      ...derived(item.nome.trim(), sku, html, extraHtml, category),
      // Só grava o hash quando o detalhe foi lido (senão a próxima execução tenta de novo).
      ...(detail || !needsDetail ? { listHash: hash } : {}),
      ...(detail ? { detailSyncedAt: new Date() } : {}),
    } satisfies Prisma.ProductUpdateInput;

    if (prev) {
      await db.product.update({ where: { blingId }, data: base });
      // "atualizado" = algo mudou de fato (o link da imagem muda sempre e não conta)
      const changed =
        prev.listHash !== hash || Number(prev.stock) !== stock || prev.active !== active || prev.categoryId !== categoryId;
      if (changed) result.updated++;
    } else {
      await db.product.create({ data: { blingId, ...base } });
      result.created++;
    }
  }

  // Listagem completa deu certo → o que não apareceu saiu de linha (inativo/excluído no Bling).
  const gone = await db.product.updateMany({ where: { active: true, syncedAt: { lt: startedAt } }, data: { active: false } });
  result.deactivated = gone.count;
  result.ms = Date.now() - t0;
  return result;
}

/** Links atuais das imagens de um produto (os do Bling expiram; usar na hora de enviar). */
export async function fetchProductImages(deps: SyncDeps, blingId: string, client: BlingClient = blingClient(deps)): Promise<string[]> {
  const detail = (await client.get<BlingOne<BlingProductDetail>>(`/produtos/${blingId}`)).data;
  const imgs = detail.midia?.imagens;
  return [...(imgs?.internas ?? []), ...(imgs?.externas ?? []), ...(imgs?.imagensURL ?? [])].map((i) => i.link).filter(Boolean);
}
