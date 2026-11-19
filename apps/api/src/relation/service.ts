import type { Contact, PrismaClient, RelationKind } from '@prisma/client';
import { blingClient } from '../bling/client.js';
import { getBlingContact, linkContactToBling } from '../bling/orders.js';
import type { BlingOrderListItem, BlingPage } from '../bling/types.js';
import { addDays, spDate } from '../charges/config.js';
import type { Deps } from '../deps.js';
import { badRequest, HttpError } from '../http/errors.js';
import type { Agent } from '../inbox/service.js';
import { childLogger } from '../lib/logger.js';
import { NotifyError, sendTemplateTo } from '../messaging/notify.js';
import { TIKTOK_STORE_ID } from '../orders/config.js';
import { effectiveOrderConfig } from '../orders/situations.js';
import { firstName } from '../orders/engine.js';
import { getSetting, setSetting } from '../settings.js';

/**
 * Relacionamento (documento da Ellen): pedido de avaliação, aniversário e "hora de repor".
 * Só para quem deu opt-in e nunca saiu. Cada mensagem é um clique (ou "enviar selecionados").
 * Aniversário e última compra vêm do cadastro/pedidos do Bling e ficam copiados no contato.
 */

const log = childLogger('relacionamento');

export const RELATION_KINDS = ['AVALIACAO', 'ANIVERSARIO', 'RECOMPRA', 'CARRINHO'] as const satisfies readonly RelationKind[];
export type RelationKindKey = (typeof RELATION_KINDS)[number];

export const RELATION_INFO: Record<RelationKindKey, { label: string; when: string; vars: string[]; suggested: { name: string; body: string; examples: string[] } }> = {
  AVALIACAO: {
    label: 'Pedido de avaliação',
    when: '2 dias depois de o pedido ficar Atendido',
    vars: ['primeiro nome', 'nº do pedido', 'link de avaliação'],
    suggested: {
      name: 'rel_avaliacao',
      body: 'Oi, {{1}}! Seu pedido nº {{2}} chegou bem? Conta pra gente o que achou: {{3}} Sua opinião ajuda muito a Oliver Cosméticos. Obrigada!',
      examples: ['Maria', '8825', 'https://g.page/r/oliver/review'],
    },
  },
  ANIVERSARIO: {
    label: 'Aniversário',
    when: 'No dia do aniversário (data de nascimento no Bling)',
    vars: ['primeiro nome', 'presente (cupom ou mimo)'],
    suggested: {
      name: 'rel_aniversario',
      body: 'Feliz aniversário, {{1}}! A Oliver Cosméticos preparou um presente pra você: {{2}}. Aproveite o seu dia!',
      examples: ['Maria', '10% de desconto com o cupom NIVER10 até o fim do mês'],
    },
  },
  RECOMPRA: {
    label: 'Hora de repor',
    when: 'X dias depois da última compra',
    vars: ['primeiro nome', 'link da loja'],
    suggested: {
      name: 'rel_recompra',
      body: 'Oi, {{1}}! Já faz um tempinho desde a sua última compra na Oliver Cosméticos. Que tal repor os seus favoritos? Veja as novidades: {{2}} Qualquer dúvida é só chamar.',
      examples: ['Maria', 'https://blackfridaydaoliver.com'],
    },
  },
  CARRINHO: {
    label: 'Carrinho parado',
    when: 'De 1 h a 3 dias depois de o site avisar (some quando vira pedido)',
    vars: ['primeiro nome', 'produtos do carrinho', 'link do carrinho'],
    suggested: {
      name: 'rel_carrinho',
      body: 'Oi, {{1}}! Você deixou no carrinho da Oliver Cosméticos: {{2}}. Para finalizar é só tocar aqui: {{3}} Qualquer dúvida, responda esta mensagem.',
      examples: ['Maria', 'Lattafa Asad 100ml e Yara 100ml', 'https://blackfridaydaoliver.com/carrinho/abc123'],
    },
  },
};

export interface RelationConfig {
  reviewLink: string;
  birthdayGift: string;
  restockDays: number;
  restockLink: string;
  phoneNumberId: string | null;
  templates: Record<RelationKindKey, string>;
}

const KEY = 'relation.config';
const SYNC_KEY = 'relation.sync';
const REVIEW_AFTER_DAYS = 2;
const REVIEW_WINDOW_DAYS = 7; // depois disso o pedido sai da lista (avaliação atrasada não faz sentido)
const RESTOCK_WINDOW_DAYS = 7;
const CART_AFTER_MS = 3600_000; // espera 1 h (a cliente pode estar finalizando)
const CART_WINDOW_MS = 3 * 86_400_000;

export async function getRelationConfig(db: PrismaClient): Promise<RelationConfig> {
  const base: RelationConfig = {
    reviewLink: '',
    birthdayGift: '',
    restockDays: 45,
    restockLink: '',
    phoneNumberId: null,
    templates: Object.fromEntries(RELATION_KINDS.map((k) => [k, RELATION_INFO[k].suggested.name])) as RelationConfig['templates'],
  };
  const saved = await getSetting<Partial<RelationConfig> | null>(db, KEY, null);
  return saved ? { ...base, ...saved, templates: { ...base.templates, ...saved.templates } } : base;
}

export async function saveRelationConfig(db: PrismaClient, cfg: RelationConfig) {
  await setSetting(db, KEY, cfg);
}

export async function getRelationSync(db: PrismaClient) {
  return getSetting<{ lastSyncAt: string | null; checked: number; pending: number; lastError: string | null }>(db, SYNC_KEY, { lastSyncAt: null, checked: 0, pending: 0, lastError: null });
}

const optedIn = { optIn: true, optOut: false } as const;

/**
 * Lê no Bling o aniversário e a última compra de quem deu opt-in (no máximo `limit` por rodada,
 * quem não foi lido há 7 dias primeiro). Vincula ao cadastro do Bling quem ainda não está.
 */
export async function syncRelationData(deps: Deps, opts: { limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 150;
  const client = blingClient(deps);
  const stale = new Date(now.getTime() - 7 * 86_400_000);
  const due = await deps.db.contact.findMany({
    where: { ...optedIn, isSupplier: false, OR: [{ blingCheckedAt: null }, { blingCheckedAt: { lt: stale } }] },
    orderBy: [{ blingCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
  });
  let checked = 0;
  try {
    for (const c of due) {
      let contact: Contact = c;
      if (!contact.blingContactId) {
        const linked = await linkContactToBling(deps, contact.id, client).catch(() => null);
        if (linked?.contact) contact = linked.contact;
      }
      const data: { blingCheckedAt: Date; birthDate?: string | null; lastOrderDate?: string | null } = { blingCheckedAt: now };
      if (contact.blingContactId) {
        const b = await getBlingContact(deps, contact.blingContactId, client);
        const birth = b?.dadosAdicionais?.dataNascimento;
        data.birthDate = birth && !birth.startsWith('0000') ? birth : null;
        const orders = await client.get<BlingPage<BlingOrderListItem>>('/pedidos/vendas', { idContato: contact.blingContactId, limite: 100 });
        const dates = orders.data.filter((o) => o.situacao.id !== 12 && o.data && !o.data.startsWith('0000')).map((o) => o.data);
        data.lastOrderDate = dates.sort().at(-1) ?? null;
      }
      await deps.db.contact.update({ where: { id: contact.id }, data });
      checked++;
    }
    const pending = await deps.db.contact.count({ where: { ...optedIn, isSupplier: false, OR: [{ blingCheckedAt: null }, { blingCheckedAt: { lt: stale } }] } });
    await setSetting(deps.db, SYNC_KEY, { lastSyncAt: now.toISOString(), checked, pending, lastError: null });
    return { checked, pending };
  } catch (err) {
    const msg = `Erro ao ler o Bling: ${(err as Error).message}`.slice(0, 300);
    await setSetting(deps.db, SYNC_KEY, { lastSyncAt: now.toISOString(), checked, pending: due.length - checked, lastError: msg });
    throw new Error(msg, { cause: err });
  }
}

export interface RelationRow {
  key: string;
  kind: RelationKindKey;
  contactId: string;
  name: string;
  phone: string;
  detail: string;
  variables: string[];
  preview: string;
  alreadySent: boolean;
  blocked: string | null;
}

export async function buildRelationLists(deps: Deps, now = new Date()) {
  const cfg = await getRelationConfig(deps.db);
  const orderCfg = await effectiveOrderConfig(deps);
  const today = spDate(now);
  const templates = await deps.db.template.findMany({ where: { name: { in: Object.values(cfg.templates) }, status: { not: 'DELETED' } } });
  const sentKeys = new Set((await deps.db.relationNotice.findMany({ where: { status: 'SENT', createdAt: { gte: new Date(now.getTime() - 400 * 86_400_000) } }, select: { key: true } })).map((r) => r.key));

  const make = (kind: RelationKindKey, key: string, c: Contact, nameOverride: string | null, detail: string, variables: string[]): RelationRow => {
    const tpl = templates.find((t) => t.name === cfg.templates[kind]);
    let blocked: string | null = null;
    if (kind === 'AVALIACAO' && !cfg.reviewLink.trim()) blocked = 'Falta o link de avaliação nas configurações';
    else if (kind === 'ANIVERSARIO' && !cfg.birthdayGift.trim()) blocked = 'Falta o presente (cupom ou mimo) nas configurações';
    else if (kind === 'RECOMPRA' && !cfg.restockLink.trim()) blocked = 'Falta o link da loja nas configurações';
    else if (!tpl) blocked = `Template "${cfg.templates[kind]}" não existe ainda`;
    else if (tpl.status !== 'APPROVED') blocked = `Template "${tpl.name}" ainda não aprovado pela Meta`;
    return {
      key,
      kind,
      contactId: c.id,
      name: nameOverride || c.name || c.phone,
      phone: c.phone,
      detail,
      variables,
      preview: RELATION_INFO[kind].suggested.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => variables[Number(n) - 1] ?? ''),
      alreadySent: sentKeys.has(key),
      blocked,
    };
  };

  // avaliação: pedidos que ficaram Atendido há 2 a 7 dias, de cliente com opt-in
  const atendido = orderCfg.situations.ATENDIDO;
  const reviewOrders = atendido.length
    ? await deps.db.orderState.findMany({
        where: {
          situacaoId: { in: atendido },
          situacaoSince: { lte: new Date(now.getTime() - REVIEW_AFTER_DAYS * 86_400_000), gte: new Date(now.getTime() - REVIEW_WINDOW_DAYS * 86_400_000) },
          contactBlingId: { not: null },
          NOT: { lojaId: { in: [...new Set([TIKTOK_STORE_ID, ...orderCfg.excludedStores])] } },
        },
        orderBy: { situacaoSince: 'asc' },
      })
    : [];
  const reviewContacts = await deps.db.contact.findMany({ where: { ...optedIn, blingContactId: { in: reviewOrders.map((o) => o.contactBlingId!) } } });
  const byBling = new Map(reviewContacts.map((c) => [c.blingContactId!, c]));
  const avaliacao = reviewOrders
    .filter((o) => byBling.has(o.contactBlingId!))
    .map((o) => {
      const c = byBling.get(o.contactBlingId!)!;
      return make('AVALIACAO', `AVALIACAO:${o.blingOrderId}`, c, o.contactName, `pedido nº ${o.numero} atendido em ${o.situacaoSince.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, [
        firstName(o.contactName ?? c.name),
        String(o.numero),
        cfg.reviewLink.trim(),
      ]);
    });

  // aniversário: dia e mês de hoje
  const mmdd = today.slice(5);
  const birthdays = await deps.db.contact.findMany({ where: { ...optedIn, isSupplier: false, birthDate: { endsWith: `-${mmdd}` } }, orderBy: { name: 'asc' } });
  const aniversario = birthdays.map((c) => make('ANIVERSARIO', `ANIVERSARIO:${c.id}:${today.slice(0, 4)}`, c, null, `faz aniversário hoje`, [firstName(c.name), cfg.birthdayGift.trim()]));

  // hora de repor: última compra entre X e X+7 dias atrás (uma vez por compra)
  const from = addDays(today, -(cfg.restockDays + RESTOCK_WINDOW_DAYS));
  const to = addDays(today, -cfg.restockDays);
  const restock = await deps.db.contact.findMany({ where: { ...optedIn, isSupplier: false, lastOrderDate: { gte: from, lte: to } }, orderBy: { lastOrderDate: 'asc' } });
  const recompra = restock.map((c) =>
    make('RECOMPRA', `RECOMPRA:${c.id}:${c.lastOrderDate}`, c, null, `última compra em ${c.lastOrderDate!.split('-').reverse().join('/')}`, [firstName(c.name), cfg.restockLink.trim()]),
  );

  // carrinho parado: o site informou (POST /api/site/v1/carts) e ainda não virou pedido
  const carts = await deps.db.abandonedCart.findMany({
    where: { recoveredAt: null, updatedAt: { lte: new Date(now.getTime() - CART_AFTER_MS), gte: new Date(now.getTime() - CART_WINDOW_MS) } },
    orderBy: { updatedAt: 'asc' },
  });
  const cartContacts = new Map((await deps.db.contact.findMany({ where: { ...optedIn, phone: { in: carts.map((c) => c.phone) } } })).map((c) => [c.phone, c]));
  const carrinho = carts
    .filter((k) => cartContacts.has(k.phone))
    .map((k) => {
      const c = cartContacts.get(k.phone)!;
      const items = (k.items as { name: string; qty: number }[]).map((i) => (i.qty > 1 ? `${i.qty}x ${i.name}` : i.name));
      const list = items.length > 3 ? `${items.slice(0, 3).join(', ')} e mais ${items.length - 3}` : items.join(' e ');
      return make('CARRINHO', `CARRINHO:${k.id}`, c, k.name, `carrinho de ${k.updatedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${k.total ? ` · R$ ${k.total.toFixed(2).replace('.', ',')}` : ''}`, [
        firstName(k.name ?? c.name),
        list.slice(0, 300),
        k.link,
      ]);
    });

  const [optInTotal, withBirth, withLastOrder] = await Promise.all([
    deps.db.contact.count({ where: { ...optedIn, isSupplier: false } }),
    deps.db.contact.count({ where: { ...optedIn, isSupplier: false, birthDate: { not: null } } }),
    deps.db.contact.count({ where: { ...optedIn, isSupplier: false, lastOrderDate: { not: null } } }),
  ]);
  return { today, avaliacao, aniversario, recompra, carrinho, stats: { optInTotal, withBirth, withLastOrder } };
}

export async function sendRelation(deps: Deps, who: Agent, key: string, lists?: Awaited<ReturnType<typeof buildRelationLists>>) {
  const cfg = await getRelationConfig(deps.db);
  const all = lists ?? (await buildRelationLists(deps));
  const row = [...all.avaliacao, ...all.aniversario, ...all.recompra, ...all.carrinho].find((r) => r.key === key);
  if (!row) throw new HttpError(409, 'Essa mensagem não está mais na lista. Atualize a tela.');
  if (row.alreadySent) throw new HttpError(409, 'Essa mensagem já foi enviada.');
  if (row.blocked) throw badRequest(row.blocked);
  try {
    const r = await sendTemplateTo(deps, { phone: row.phone, templateName: cfg.templates[row.kind], body: row.variables, numberId: cfg.phoneNumberId, who });
    await deps.db.relationNotice.upsert({
      where: { key },
      create: { key, kind: row.kind, contactId: row.contactId, status: 'SENT', variables: row.variables, conversationId: r.conversationId, sentByUserId: who.id },
      update: { status: 'SENT', reason: null, variables: row.variables, conversationId: r.conversationId, sentByUserId: who.id },
    });
    log.info({ tipo: row.kind, contato: row.contactId, por: who.name }, 'Mensagem de relacionamento enviada');
    return { key, status: 'SENT' as const, conversationId: r.conversationId };
  } catch (err) {
    const reason = (err instanceof NotifyError ? err.message : (err as Error).message).slice(0, 300);
    await deps.db.relationNotice.upsert({
      where: { key },
      create: { key, kind: row.kind, contactId: row.contactId, status: 'FAILED', reason, sentByUserId: who.id },
      update: { status: 'FAILED', reason },
    });
    return { key, status: 'FAILED' as const, reason };
  }
}
