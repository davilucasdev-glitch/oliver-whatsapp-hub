import type { PrismaClient, SupplierSendKind } from '@prisma/client';
import { blingClient, BlingApiError, type BlingClient } from '../bling/client.js';
import { getBlingContact, situationName } from '../bling/orders.js';
import type { BlingContact, BlingOne, BlingPage } from '../bling/types.js';
import { addDays, spDate } from '../charges/config.js';
import type { Deps } from '../deps.js';
import { badRequest, HttpError } from '../http/errors.js';
import type { Agent } from '../inbox/service.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { NotifyError, pickSendingNumber, sendTemplateTo } from '../messaging/notify.js';
import { createTemplate } from '../templates/service.js';
import { managementClient } from '../numbers/service.js';
import { getSetting, setSetting } from '../settings.js';
import { purchaseOrderPdf, type PurchaseOrderForPdf } from './pdf.js';

/**
 * Fornecedores (documento da Ellen, "Operação"): cotação em PDF e pedido de compra depois de
 * lançado no Bling, pelo número oficial. A resposta do fornecedor cai na Inbox com o nome dele
 * e com a responsável (Ellen). Sempre um clique de alguém da equipe.
 */

const log = childLogger('fornecedores');

export const SUPPLIER_KINDS = ['PEDIDO_COMPRA', 'COTACAO'] as const satisfies readonly SupplierSendKind[];
export type SupplierKindKey = (typeof SUPPLIER_KINDS)[number];

export const SUPPLIER_INFO: Record<SupplierKindKey, { label: string; vars: string[]; suggested: { name: string; body: string; examples: string[] } }> = {
  PEDIDO_COMPRA: {
    label: 'Pedido de compra (PDF)',
    vars: ['nome do fornecedor', 'nº do pedido', 'total'],
    suggested: {
      name: 'compra_pedido',
      body: 'Olá, {{1}}! Segue o pedido de compra nº {{2}} da Oliver Cosméticos, total {{3}}. Qualquer dúvida é só responder esta mensagem.',
      examples: ['Beauty Mania', '191', 'R$ 5.052,71'],
    },
  },
  COTACAO: {
    label: 'Cotação (PDF)',
    vars: ['nome do fornecedor'],
    suggested: {
      name: 'compra_cotacao',
      body: 'Olá, {{1}}! Segue a cotação da Oliver Cosméticos. Pode nos responder com preços e prazo por aqui? Obrigada!',
      examples: ['Beauty Mania'],
    },
  },
};

export interface SupplierConfig {
  ownerUserId: string | null;
  phoneNumberId: string | null;
  templates: Record<SupplierKindKey, string>;
}

const KEY = 'suppliers.config';

export async function getSupplierConfig(db: PrismaClient): Promise<SupplierConfig> {
  const base: SupplierConfig = { ownerUserId: null, phoneNumberId: null, templates: { PEDIDO_COMPRA: 'compra_pedido', COTACAO: 'compra_cotacao' } };
  const saved = await getSetting<Partial<SupplierConfig> | null>(db, KEY, null);
  return saved ? { ...base, ...saved, templates: { ...base.templates, ...saved.templates } } : base;
}

export async function saveSupplierConfig(db: PrismaClient, cfg: SupplierConfig) {
  await setSetting(db, KEY, cfg);
}

interface BlingPurchaseOrder {
  id: number;
  numero: number;
  data: string;
  dataPrevista?: string;
  fornecedor: { id: number };
  situacao: { id: number; valor?: number };
  total: number;
  totalProdutos: number;
  observacoes?: string;
  itens?: { descricao: string; codigoFornecedor?: string; produto?: { id: number; codigo?: string }; quantidade: number; unidade?: string; valor: number }[];
  transporte?: { frete?: number };
}

const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

function supplierPhone(c: BlingContact | null): string | null {
  for (const raw of [c?.celular, c?.telefone]) {
    const p = raw ? normalizePhone(raw) : null;
    if (p) return p;
  }
  return null;
}

const listCache = { at: 0, data: null as null | Awaited<ReturnType<typeof loadPurchaseOrders>> };

async function loadPurchaseOrders(deps: Deps, client: BlingClient) {
  const today = spDate();
  const res = await client.get<BlingPage<BlingPurchaseOrder>>('/pedidos/compras', { dataInicial: addDays(today, -45), dataFinal: today, limite: 100 });
  const suppliers = new Map<number, BlingContact | null>();
  const rows = [];
  for (const po of [...res.data].sort((a, b) => b.numero - a.numero).slice(0, 40)) {
    if (!suppliers.has(po.fornecedor.id)) suppliers.set(po.fornecedor.id, await getBlingContact(deps, String(po.fornecedor.id), client).catch(() => null));
    const s = suppliers.get(po.fornecedor.id) ?? null;
    rows.push({
      id: String(po.id),
      numero: po.numero,
      data: po.data,
      total: po.total,
      situacao: await situationName(client, po.situacao.id),
      supplier: { id: String(po.fornecedor.id), nome: s?.nome ?? `Fornecedor ${po.fornecedor.id}`, phone: supplierPhone(s) },
    });
  }
  return rows;
}

/** Pedidos de compra dos últimos 45 dias (guardados 2 min) com o último envio de cada um. */
export async function listPurchaseOrders(deps: Deps, refresh = false) {
  const client = blingClient(deps);
  if (refresh || !listCache.data || Date.now() - listCache.at > 2 * 60_000) {
    listCache.data = await loadPurchaseOrders(deps, client);
    listCache.at = Date.now();
  }
  const sends = await deps.db.supplierSend.findMany({ where: { purchaseOrderId: { in: listCache.data.map((r) => r.id) } }, orderBy: { createdAt: 'desc' } });
  return listCache.data.map((r) => {
    const last = sends.find((s) => s.purchaseOrderId === r.id) ?? null;
    return { ...r, lastSend: last ? { status: last.status, at: last.createdAt, reason: last.reason, conversationId: last.conversationId } : null };
  });
}

export function clearPurchaseOrderCache() {
  listCache.data = null;
}

async function getPurchaseOrder(client: BlingClient, id: string): Promise<BlingPurchaseOrder | null> {
  try {
    return (await client.get<BlingOne<BlingPurchaseOrder>>(`/pedidos/compras/${id}`)).data;
  } catch (err) {
    if (err instanceof BlingApiError && err.status === 404) return null;
    throw err;
  }
}

export async function purchaseOrderForPdf(deps: Deps, id: string): Promise<{ pdf: PurchaseOrderForPdf; supplier: BlingContact | null; po: BlingPurchaseOrder }> {
  const client = blingClient(deps);
  const po = await getPurchaseOrder(client, id);
  if (!po) throw new HttpError(404, 'Pedido de compra não encontrado no Bling.');
  const supplier = await getBlingContact(deps, String(po.fornecedor.id), client);
  return {
    po,
    supplier,
    pdf: {
      numero: po.numero,
      data: po.data,
      dataPrevista: po.dataPrevista ?? null,
      fornecedor: { nome: supplier?.nome ?? `Fornecedor ${po.fornecedor.id}`, documento: supplier?.numeroDocumento ?? null, telefone: supplier?.celular || supplier?.telefone || null },
      itens: (po.itens ?? []).map((i) => ({ codigo: i.codigoFornecedor || i.produto?.codigo || null, descricao: i.descricao, quantidade: i.quantidade, unidade: i.unidade ?? null, valor: i.valor })),
      totalProdutos: po.totalProdutos,
      frete: po.transporte?.frete ?? null,
      total: po.total,
      observacoes: po.observacoes ?? null,
    },
  };
}

const supplierFirst = (name: string) => {
  const clean = name.replace(/\b(LTDA|ME|EIRELI|S\/?A|EPP|MEI)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  // "BEAUTY MANIA PERFUMES E COSMETICOS" → "Beauty Mania"
  const words = clean.split(' ').slice(0, 2).join(' ');
  return words.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) || 'fornecedor';
};

async function sendPdf(
  deps: Deps,
  who: Agent,
  input: { kind: SupplierKindKey; phone: string; supplierName: string; supplierBlingId: string | null; pdf: Buffer; filename: string; body: string[]; purchaseOrderId?: string; purchaseOrderNumber?: number },
) {
  const cfg = await getSupplierConfig(deps.db);
  const number = await pickSendingNumber(deps, cfg.phoneNumberId);
  if (!number) throw badRequest('Nenhum número de atendimento ativo.');
  const base = {
    kind: input.kind,
    supplierBlingId: input.supplierBlingId,
    supplierName: input.supplierName,
    phone: input.phone,
    purchaseOrderId: input.purchaseOrderId ?? null,
    purchaseOrderNumber: input.purchaseOrderNumber ?? null,
    filename: input.filename,
    sentByUserId: who.id,
  };
  try {
    const mediaId = await deps.providers(number).uploadMedia(input.pdf, 'application/pdf', input.filename);
    const r = await sendTemplateTo(deps, {
      phone: input.phone,
      name: input.supplierName,
      blingContactId: input.supplierBlingId,
      isSupplier: true,
      templateName: cfg.templates[input.kind],
      body: input.body,
      headerDocument: { id: mediaId, filename: input.filename },
      numberId: number.id,
      who,
      ownerUserId: cfg.ownerUserId,
    });
    await deps.db.supplierSend.create({ data: { ...base, status: 'SENT', conversationId: r.conversationId } });
    log.info({ tipo: input.kind, fornecedor: input.supplierName, por: who.name }, 'PDF enviado ao fornecedor');
    return { status: 'SENT' as const, conversationId: r.conversationId };
  } catch (err) {
    const reason = (err instanceof NotifyError ? err.message : (err as Error).message).slice(0, 300);
    await deps.db.supplierSend.create({ data: { ...base, status: 'FAILED', reason } });
    return { status: 'FAILED' as const, reason };
  }
}

export async function sendPurchaseOrder(deps: Deps, who: Agent, id: string) {
  const { pdf, supplier, po } = await purchaseOrderForPdf(deps, id);
  const phone = supplierPhone(supplier);
  if (!phone) throw badRequest(`O fornecedor "${pdf.fornecedor.nome}" não tem celular/telefone no Bling.`);
  const file = await purchaseOrderPdf(pdf);
  return sendPdf(deps, who, {
    kind: 'PEDIDO_COMPRA',
    phone,
    supplierName: pdf.fornecedor.nome,
    supplierBlingId: String(po.fornecedor.id),
    pdf: file,
    filename: `Pedido de compra ${po.numero} - Oliver Cosmeticos.pdf`,
    body: [supplierFirst(pdf.fornecedor.nome), String(po.numero), brl(po.total)],
    purchaseOrderId: String(po.id),
    purchaseOrderNumber: po.numero,
  });
}

export async function sendQuote(deps: Deps, who: Agent, input: { pdf: Buffer; filename: string; supplierBlingId?: string | null; phone?: string | null; name?: string | null }) {
  if (input.pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('Envie a cotação em PDF.');
  let name = input.name?.trim() || null;
  let phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.supplierBlingId) {
    const c = await getBlingContact(deps, input.supplierBlingId, blingClient(deps));
    if (!c) throw badRequest('Fornecedor não encontrado no Bling.');
    name = c.nome;
    phone = phone ?? supplierPhone(c);
  }
  if (!phone) throw badRequest('Informe o WhatsApp do fornecedor (o cadastro no Bling não tem celular).');
  if (!name) throw badRequest('Informe o nome do fornecedor.');
  const filename = /\.pdf$/i.test(input.filename) ? input.filename : `${input.filename || 'Cotacao Oliver Cosmeticos'}.pdf`;
  return sendPdf(deps, who, { kind: 'COTACAO', phone, supplierName: name, supplierBlingId: input.supplierBlingId ?? null, pdf: input.pdf, filename, body: [supplierFirst(name)] });
}

export async function searchSuppliers(deps: Deps, q: string) {
  const client = blingClient(deps);
  const res = await client.get<BlingPage<BlingContact>>('/contatos', { pesquisa: q, limite: 15 });
  return res.data.map((c) => ({ id: String(c.id), nome: c.nome, documento: c.numeroDocumento ?? null }));
}

export async function supplierContact(deps: Deps, id: string) {
  const c = await getBlingContact(deps, id, blingClient(deps));
  if (!c) throw new HttpError(404, 'Fornecedor não encontrado no Bling.');
  return { id: String(c.id), nome: c.nome, phone: supplierPhone(c), fornecedor: (c.tiposContato ?? []).some((t) => /fornecedor/i.test(t.descricao)) };
}

/** Cria os 2 templates com PDF no cabeçalho (precisa de META_APP_ID para enviar o PDF de exemplo). */
export async function createSupplierTemplates(deps: Deps) {
  const cfg = await getSupplierConfig(deps.db);
  const results = [];
  let handle: string | null = null;
  for (const k of SUPPLIER_KINDS) {
    const s = SUPPLIER_INFO[k].suggested;
    const name = cfg.templates[k];
    const existing = await deps.db.template.findFirst({ where: { name, status: { not: 'DELETED' } } });
    if (existing) {
      results.push({ kind: k, name, status: existing.status });
      continue;
    }
    try {
      if (!deps.env.META_APP_ID) throw new Error('Falta META_APP_ID no .env (ID do app da Meta): ele é usado para enviar o PDF de exemplo do template.');
      if (!handle) {
        const sample = await purchaseOrderPdf({
          numero: 1,
          data: spDate(),
          fornecedor: { nome: 'Fornecedor de exemplo' },
          itens: [{ codigo: 'EX01', descricao: 'Produto de exemplo', quantidade: 1, valor: 10 }],
          totalProdutos: 10,
          total: 10,
        });
        handle = await managementClient(deps).uploadTemplateSample(deps.env.META_APP_ID, sample, 'application/pdf', 'exemplo.pdf');
      }
      const row = await createTemplate(deps, {
        name,
        language: 'pt_BR',
        category: 'UTILITY',
        headerFormat: 'DOCUMENT',
        headerHandle: handle,
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
  return results;
}
