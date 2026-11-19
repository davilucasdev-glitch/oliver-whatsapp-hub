import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeSearch } from './html.js';

/**
 * Busca de produtos (painel e, na etapa 5, a ferramenta buscar_produtos do bot).
 * Texto normalizado (sem acento) + pg_trgm: todas as palavras batendo vêm primeiro,
 * depois os parecidos (tolera erro de digitação, ex.: "lataffa" → "Lattafa").
 */

export interface ProductSearch {
  query?: string;
  category?: string;
  gender?: string;
  /** qualquer um destes gêneros (o bot inclui "unissex" junto) */
  genders?: string[];
  inStock?: boolean;
  priceMin?: number;
  priceMax?: number;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

const SIMILARITY_MIN = 0.35;
const TOKEN_SIMILARITY_MIN = 0.5;
/** palavras que não ajudam a achar produto ("tem perfume doce pra mim?") */
const STOPWORDS = new Set(
  'de da do das dos para pra pro com sem um uma uns umas o a os as e ou que tem voces vc vcs quero queria gostaria algum alguma me mim meu minha no na nos nas em por mais muito bem bom boa qual quais ai oi ola favor'.split(' '),
);

function filters(s: ProductSearch): Prisma.Sql[] {
  const where: Prisma.Sql[] = [];
  if (!s.includeInactive) where.push(Prisma.sql`"active" = true`);
  if (s.category) where.push(Prisma.sql`"category" ILIKE ${`%${s.category}%`}`);
  if (s.gender) where.push(Prisma.sql`"gender" = ${s.gender}`);
  if (s.genders?.length) where.push(Prisma.sql`"gender" IN (${Prisma.join(s.genders)})`);
  if (s.inStock) where.push(Prisma.sql`"stock" > 0`);
  if (s.priceMin !== undefined) where.push(Prisma.sql`"price" >= ${s.priceMin}`);
  if (s.priceMax !== undefined) where.push(Prisma.sql`"price" <= ${s.priceMax}`);
  return where;
}

export async function searchProductIds(db: PrismaClient, s: ProductSearch): Promise<{ ids: string[]; total: number }> {
  const limit = Math.min(Math.max(s.limit ?? 20, 1), 100);
  const offset = Math.max(s.offset ?? 0, 0);
  const where = filters(s);
  const q = normalizeSearch(s.query ?? '');
  const tokens = [...new Set(q.split(' ').filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].slice(0, 8);

  if (!tokens.length) {
    const cond = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Product" ${cond}
      ORDER BY ("stock" > 0) DESC, "name" ASC LIMIT ${limit} OFFSET ${offset}`;
    const n = (await db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "Product" ${cond}`)[0]?.n ?? 0;
    return { ids: rows.map((r) => r.id), total: n };
  }

  // Quantas palavras da busca aparecem no produto (exata ou com erro de digitação).
  const score = Prisma.join(
    tokens.map(
      (t) => Prisma.sql`(CASE WHEN "searchText" LIKE ${`%${t}%`} THEN 1 WHEN word_similarity(${t}, "searchText") >= ${TOKEN_SIMILARITY_MIN} THEN 0.8 ELSE 0 END)`,
    ),
    ' + ',
  );
  // Até 2 palavras: precisa de todas; mais que isso (frase do cliente): pelo menos metade.
  const minScore = tokens.length <= 2 ? tokens.length * 0.8 : Math.ceil(tokens.length / 2);
  const query = tokens.join(' ');
  const match = Prisma.sql`((${score}) >= ${minScore} OR word_similarity(${query}, "searchText") >= ${SIMILARITY_MIN})`;
  const cond = Prisma.sql`WHERE ${Prisma.join([...where, match], ' AND ')}`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Product" ${cond}
    ORDER BY (${score}) DESC,
             word_similarity(${query}, "searchText") DESC,
             ("stock" > 0) DESC,
             "name" ASC
    LIMIT ${limit} OFFSET ${offset}`;
  const n = (await db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "Product" ${cond}`)[0]?.n ?? 0;
  return { ids: rows.map((r) => r.id), total: n };
}

const LIST_SELECT = {
  id: true,
  blingId: true,
  sku: true,
  name: true,
  price: true,
  stock: true,
  format: true,
  category: true,
  gender: true,
  shortDescription: true,
  imageUrl: true,
  active: true,
  syncedAt: true,
} satisfies Prisma.ProductSelect;

export type ProductListItem = Omit<Prisma.ProductGetPayload<{ select: typeof LIST_SELECT }>, 'price' | 'stock'> & {
  price: number;
  stock: number;
};

export async function searchProducts(db: PrismaClient, s: ProductSearch): Promise<{ products: ProductListItem[]; total: number }> {
  const { ids, total } = await searchProductIds(db, s);
  const rows = await db.product.findMany({ where: { id: { in: ids } }, select: LIST_SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const products = ids
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ ...p, price: Number(p.price), stock: Number(p.stock) }));
  return { products, total };
}

export async function productCategories(db: PrismaClient): Promise<{ category: string; count: number }[]> {
  const rows = await db.product.groupBy({
    by: ['category'],
    where: { active: true, category: { not: null } },
    _count: { _all: true },
    orderBy: { category: 'asc' },
  });
  return rows.map((r) => ({ category: r.category!, count: r._count._all }));
}
