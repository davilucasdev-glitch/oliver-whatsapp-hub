import type Anthropic from '@anthropic-ai/sdk';
import type { Product } from '@prisma/client';
import { z } from 'zod';
import { BlingApiError, BlingNotConnectedError } from '../bling/client.js';
import { isValidDocument, lookupOrdersForCustomer, onlyDigits, type OrderSummary } from '../bling/orders.js';
import { searchProducts } from '../bling/products.js';
import { fetchProductImages } from '../bling/sync.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import type { BotIO } from './io.js';

const log = childLogger('bot:tools');

/** Ferramentas que o modelo pode chamar. A ordem e o texto não mudam entre chamadas (cache de prompt). */
export const BOT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos da Oliver no catálogo (cópia do Bling). Devolve no máximo 5 itens, só com estoque. Use antes de recomendar ou falar de qualquer produto. A consulta aceita nome, marca, tipo (perfume, body splash, creatina…), notas olfativas, família ou ocasião.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'O que procurar, ex.: "perfume árabe doce baunilha", "lattafa yara", "creatina gummy"' },
        categoria: { type: 'string', description: 'Parte do nome da categoria, ex.: "Árabes", "Body", "Suplementos" (opcional)' },
        genero: { type: 'string', enum: ['feminino', 'masculino', 'unissex', 'infantil'], description: 'Opcional. Feminino/masculino já incluem os unissex.' },
        faixa_preco: {
          type: 'object',
          properties: { min: { type: 'number' }, max: { type: 'number' } },
          description: 'Opcional, em reais, ex.: {"max": 200}',
        },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'detalhes_produto',
    description: 'Ficha completa de um produto (descrição, ficha olfativa, preço, estoque) pelo código que veio em buscar_produtos.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Campo "codigo" devolvido por buscar_produtos' } },
      required: ['sku'],
    },
  },
  {
    name: 'consultar_pedido',
    description:
      'Consulta pedidos do cliente desta conversa no Bling (situação, itens, previsão, rastreio). Sem número, traz os últimos pedidos do cliente pelo telefone ou CPF/CNPJ. Só mostra pedidos do próprio cliente.',
    input_schema: {
      type: 'object',
      properties: {
        numero_pedido: { type: 'integer', description: 'Número do pedido, se o cliente informou' },
        cpf_cnpj: { type: 'string', description: 'CPF ou CNPJ usado na compra, se o cliente informou' },
      },
    },
  },
  {
    name: 'transferir_para_humano',
    description:
      'Passa a conversa para um atendente humano (o bot para de responder este cliente e a equipe é avisada no painel). Depois, escreva ao cliente uma mensagem curta avisando.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Motivo em poucas palavras, ex.: "troca de produto", "fechar pedido", "reclamação de atraso"' } },
      required: ['motivo'],
    },
  },
  {
    name: 'enviar_imagem_produto',
    description: 'Envia ao cliente a foto de um produto (pelo código de buscar_produtos). A foto chega antes da sua resposta em texto.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Campo "codigo" devolvido por buscar_produtos' } },
      required: ['sku'],
    },
  },
];

export type ToolOutcome = 'ok' | 'not_found' | 'error';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** usado para contar tentativas sem resolver */
  outcome: ToolOutcome;
  handoff?: boolean;
}

export interface ToolContext {
  deps: Pick<Deps, 'env' | 'db'>;
  io: BotIO;
  humanOpen: boolean;
  nextOpening: string | null;
  imagesSent: number;
}

const MAX_IMAGES_PER_TURN = 3;

/** Código do produto para o modelo: SKU do Bling ou, sem SKU, o id do Bling com prefixo. */
export const productCode = (p: Pick<Product, 'sku' | 'blingId'>) => p.sku ?? `ID-${p.blingId}`;

async function findByCode(deps: ToolContext['deps'], code: string): Promise<Product | null> {
  const c = code.trim();
  if (!c) return null;
  if (/^ID-\d+$/i.test(c)) return deps.db.product.findUnique({ where: { blingId: c.slice(3) } });
  return (
    (await deps.db.product.findFirst({ where: { sku: c, active: true } })) ??
    (await deps.db.product.findFirst({ where: { sku: { equals: c, mode: 'insensitive' }, active: true } }))
  );
}

const inspiredIn = (text: string | null) => /inspirad[oa] (?:em|no|na) ([^.\n]+)/i.exec(text ?? '')?.[1]?.trim() ?? null;

const money = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');

const searchInput = z.object({
  consulta: z.string().trim().min(1).max(200),
  categoria: z.string().trim().max(100).optional(),
  genero: z.enum(['feminino', 'masculino', 'unissex', 'infantil']).optional(),
  faixa_preco: z.object({ min: z.number().min(0).optional(), max: z.number().min(0).optional() }).optional(),
});

async function buscarProdutos(ctx: ToolContext, input: unknown): Promise<ToolResult> {
  const q = searchInput.parse(input);
  const genders = q.genero === 'feminino' || q.genero === 'masculino' ? [q.genero, 'unissex'] : q.genero ? [q.genero] : undefined;
  const base = { inStock: true, limit: 5, category: q.categoria, genders, priceMin: q.faixa_preco?.min, priceMax: q.faixa_preco?.max };
  let { products } = await searchProducts(ctx.deps.db, { ...base, query: q.consulta });
  let note: string | undefined;
  // Consulta longa demais ("perfume árabe doce para noite"): tenta de novo só com as palavras mais longas.
  if (!products.length && q.consulta.split(/\s+/).length > 2) {
    const shorter = q.consulta.split(/\s+/).sort((a, b) => b.length - a.length).slice(0, 2).join(' ');
    ({ products } = await searchProducts(ctx.deps.db, { ...base, query: shorter }));
    if (products.length) note = `Nada com todos os termos; resultados para "${shorter}".`;
  }
  if (!products.length) {
    return { outcome: 'not_found', content: JSON.stringify({ resultados: [], aviso: 'Nenhum produto com estoque encontrado. Não invente; ofereça procurar outro estilo ou um atendente.' }) };
  }
  const full = await ctx.deps.db.product.findMany({ where: { id: { in: products.map((p) => p.id) } }, select: { id: true, descriptionText: true } });
  const text = new Map(full.map((f) => [f.id, f.descriptionText]));
  return {
    outcome: 'ok',
    content: JSON.stringify({
      ...(note ? { aviso: note } : {}),
      resultados: products.map((p) => ({
        codigo: productCode(p),
        nome: p.name,
        preco: money(p.price),
        estoque: p.stock,
        categoria: p.category,
        genero: p.gender,
        tipo: p.format === 'E' ? 'kit' : undefined,
        resumo: p.shortDescription,
        inspirado_em: inspiredIn(text.get(p.id) ?? null),
        tem_foto: Boolean(p.imageUrl),
      })),
    }),
  };
}

async function detalhesProduto(ctx: ToolContext, input: unknown): Promise<ToolResult> {
  const { sku } = z.object({ sku: z.string().max(80) }).parse(input);
  const p = await findByCode(ctx.deps, sku);
  if (!p || !p.active) return { outcome: 'not_found', content: JSON.stringify({ erro: `Produto "${sku}" não encontrado (ou fora de linha). Use buscar_produtos.` }) };
  const stock = Number(p.stock);
  return {
    outcome: 'ok',
    content: JSON.stringify({
      codigo: productCode(p),
      nome: p.name,
      preco: money(Number(p.price)),
      estoque: stock > 0 ? stock : 'SEM ESTOQUE: não venda; ofereça alternativas',
      categoria: p.category,
      genero: p.gender,
      tipo: p.format === 'E' ? 'kit' : undefined,
      ficha: (p.descriptionText ?? 'sem descrição cadastrada').slice(0, 4000),
    }),
  };
}

function orderForModel(o: OrderSummary) {
  return {
    numero: o.numero,
    data: o.data,
    situacao: o.situacao,
    total: money(o.total),
    itens: o.itens.map((i) => `${i.quantidade}x ${i.descricao}`),
    enviado_em: o.dataSaida,
    previsao: o.dataPrevista,
    transportadora: o.transportadora,
    rastreio: o.rastreios.length ? o.rastreios : null,
    nota_fiscal_emitida: o.notaFiscalEmitida,
  };
}

async function consultarPedido(ctx: ToolContext, input: unknown): Promise<ToolResult> {
  const q = z.object({ numero_pedido: z.coerce.number().int().positive().optional(), cpf_cnpj: z.string().max(30).optional() }).parse(input ?? {});
  const customer = await ctx.io.customer();
  const informed = q.cpf_cnpj ? onlyDigits(q.cpf_cnpj) : '';
  if (informed && !isValidDocument(informed)) {
    return { outcome: 'not_found', content: JSON.stringify({ erro: 'CPF/CNPJ inválido. Peça para o cliente conferir os números.' }) };
  }
  const document = informed || customer.document;
  const closedNote = ctx.humanOpen ? undefined : `Atendimento humano fechado; questões sobre o pedido serão vistas ${ctx.nextOpening ?? 'no próximo horário'}.`;
  try {
    const r = await lookupOrdersForCustomer(ctx.deps, { phone: customer.phone, document, blingContactId: customer.blingContactId }, q.numero_pedido ?? null);
    switch (r.status) {
      case 'found':
        if (informed) await ctx.io.saveDocument(informed, r.blingContactId);
        return { outcome: 'ok', content: JSON.stringify({ pedidos: r.orders.map(orderForModel), observacao: closedNote }) };
      case 'needs_document':
        return { outcome: 'not_found', content: JSON.stringify({ resultado: 'Não achei o cadastro pelo telefone. Peça o CPF ou CNPJ usado na compra.' }) };
      case 'not_owner':
        return { outcome: 'not_found', content: JSON.stringify({ resultado: 'Os dados não conferem com o pedido. Não revele nada sobre ele; ofereça um atendente.' }) };
      default:
        return { outcome: 'not_found', content: JSON.stringify({ resultado: 'Nenhum pedido encontrado com esses dados. Peça para conferir o número ou o CPF/CNPJ, ou ofereça um atendente.' }) };
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'consultar_pedido falhou');
    const why = err instanceof BlingNotConnectedError ? 'A consulta de pedidos está indisponível no momento.' : err instanceof BlingApiError ? 'O sistema de pedidos não respondeu.' : 'Erro ao consultar.';
    return { outcome: 'error', isError: true, content: JSON.stringify({ erro: `${why} Não invente o status; transfira para um atendente.` }) };
  }
}

async function transferir(ctx: ToolContext, input: unknown): Promise<ToolResult> {
  const { motivo } = z.object({ motivo: z.string().trim().min(1).max(300) }).parse(input);
  await ctx.io.handoff(motivo);
  return {
    outcome: 'ok',
    handoff: true,
    content: JSON.stringify({
      ok: true,
      instrucao: ctx.humanOpen
        ? 'Transferido. Avise o cliente em uma frase curta que um atendente vai continuar em instantes.'
        : `Transferido, mas o atendimento humano está fechado. Avise o cliente que um atendente responde ${ctx.nextOpening ?? 'no próximo horário de atendimento'}.`,
    }),
  };
}

async function enviarImagem(ctx: ToolContext, input: unknown): Promise<ToolResult> {
  const { sku } = z.object({ sku: z.string().max(80) }).parse(input);
  if (ctx.imagesSent >= MAX_IMAGES_PER_TURN) {
    return { outcome: 'error', isError: true, content: JSON.stringify({ erro: `Limite de ${MAX_IMAGES_PER_TURN} fotos por resposta.` }) };
  }
  const p = await findByCode(ctx.deps, sku);
  if (!p || !p.active) return { outcome: 'not_found', content: JSON.stringify({ erro: `Produto "${sku}" não encontrado.` }) };
  // Os links de imagem do Bling expiram: busca um link novo na hora; se falhar, usa o da última sincronização.
  let url: string | null = null;
  try {
    url = (await fetchProductImages(ctx.deps, p.blingId))[0] ?? null;
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'Sem link novo da imagem; usando o salvo');
  }
  url ??= p.imageUrl;
  if (!url) return { outcome: 'not_found', content: JSON.stringify({ erro: 'Este produto não tem foto cadastrada.' }) };
  try {
    await ctx.io.sendImage(url, `${p.name} — ${money(Number(p.price))}`);
  } catch (err) {
    return { outcome: 'error', isError: true, content: JSON.stringify({ erro: `Não consegui enviar a foto (${(err as Error).message}).` }) };
  }
  ctx.imagesSent++;
  return { outcome: 'ok', content: JSON.stringify({ ok: true, enviada: p.name }) };
}

const HANDLERS: Record<string, (ctx: ToolContext, input: unknown) => Promise<ToolResult>> = {
  buscar_produtos: buscarProdutos,
  detalhes_produto: detalhesProduto,
  consultar_pedido: consultarPedido,
  transferir_para_humano: transferir,
  enviar_imagem_produto: enviarImagem,
};

/** Executa uma ferramenta. Erro de validação volta como is_error para o modelo corrigir a chamada. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  const handler = HANDLERS[name] ?? HANDLERS[name.toLowerCase()];
  if (!handler) {
    return { outcome: 'error', isError: true, content: `Ferramenta "${name}" não existe. Use uma destas: ${Object.keys(HANDLERS).join(', ')}.` };
  }
  try {
    return await handler(ctx, input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { outcome: 'error', isError: true, content: `Parâmetros inválidos: ${err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}` };
    }
    log.error({ err: (err as Error).message, tool: name }, 'Ferramenta falhou');
    return { outcome: 'error', isError: true, content: `Erro interno na ferramenta (${(err as Error).message}). Não invente a resposta.` };
  }
}
