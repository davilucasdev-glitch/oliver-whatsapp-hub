import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest } from '../http/errors.js';
import { childLogger } from '../lib/logger.js';
import { managementClient } from '../numbers/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { WhatsAppApiError, type TemplateComponent } from '../whatsapp/provider.js';

const log = childLogger('templates');

export const OPT_OUT_BUTTON_TEXT = 'Parar promoções';

/** Índices das variáveis {{1}}, {{2}}… usadas num texto. */
export function templateVariables(text: string | undefined): number[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

function assertSequential(vars: number[], where: string): void {
  vars.forEach((v, i) => {
    if (v !== i + 1) throw badRequest(`${where}: as variáveis precisam ser {{1}}, {{2}}, {{3}}… em sequência.`);
  });
}

export const createTemplateSchema = z.object({
  wabaId: z.string().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, 'use só letras minúsculas, números e _ (ex.: promo_perfumes_arabes)'),
  language: z.string().default('pt_BR'),
  category: z.enum(['MARKETING', 'UTILITY']),
  header: z.string().trim().max(60, 'cabeçalho: máx. 60 caracteres').optional(),
  /** DOCUMENT = PDF no cabeçalho (o exemplo vai como handle do upload retomável) */
  headerFormat: z.enum(['TEXT', 'DOCUMENT', 'IMAGE']).default('TEXT'),
  headerHandle: z.string().optional(),
  headerExample: z.string().optional(),
  body: z.string().trim().min(1, 'informe o texto da mensagem').max(1024, 'texto: máx. 1024 caracteres'),
  bodyExamples: z.array(z.string().trim().min(1)).default([]),
  footer: z.string().trim().max(60, 'rodapé: máx. 60 caracteres').optional(),
  quickReplies: z.array(z.string().trim().min(1).max(25, 'botão: máx. 25 caracteres')).max(3).default([]),
  urlButton: z.object({ text: z.string().trim().min(1).max(25), url: z.string().url() }).optional(),
  /** Marketing: adiciona o botão "Parar promoções" (boa prática anti-bloqueio). */
  addOptOutButton: z.boolean().default(true),
});

export type CreateTemplateBody = Omit<z.infer<typeof createTemplateSchema>, 'headerFormat'> & { headerFormat?: 'TEXT' | 'DOCUMENT' | 'IMAGE' };

/** Monta os componentes no formato da Graph API, validando variáveis e exemplos. */
export function buildTemplateComponents(input: CreateTemplateBody): TemplateComponentDef[] {
  const components: TemplateComponentDef[] = [];

  if (input.headerFormat === 'DOCUMENT' || input.headerFormat === 'IMAGE') {
    if (!input.headerHandle) throw badRequest('Cabeçalho com mídia: falta o arquivo de exemplo.');
    components.push({ type: 'HEADER', format: input.headerFormat, example: { header_handle: [input.headerHandle] } });
  } else if (input.header) {
    const hv = templateVariables(input.header);
    if (hv.length > 1) throw badRequest('Cabeçalho: no máximo 1 variável ({{1}}).');
    assertSequential(hv, 'Cabeçalho');
    if (hv.length && !input.headerExample) throw badRequest('Cabeçalho: informe um exemplo para a variável {{1}}.');
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: input.header,
      ...(hv.length ? { example: { header_text: [input.headerExample!] } } : {}),
    });
  }

  const bv = templateVariables(input.body);
  assertSequential(bv, 'Texto');
  if (input.bodyExamples.length < bv.length) {
    throw badRequest(`Texto: informe um exemplo para cada variável (${bv.length} no total) — a Meta exige.`);
  }
  components.push({
    type: 'BODY',
    text: input.body,
    ...(bv.length ? { example: { body_text: [input.bodyExamples.slice(0, bv.length)] } } : {}),
  });

  if (input.footer) components.push({ type: 'FOOTER', text: input.footer });

  const quick = [...input.quickReplies];
  if (input.category === 'MARKETING' && input.addOptOutButton && !quick.some((q) => q.toLowerCase() === OPT_OUT_BUTTON_TEXT.toLowerCase())) {
    if (quick.length >= 3) throw badRequest('Com o botão "Parar promoções", use no máximo 2 respostas rápidas.');
    quick.push(OPT_OUT_BUTTON_TEXT);
  }
  const buttons: NonNullable<TemplateComponentDef['buttons']> = quick.map((text) => ({ type: 'QUICK_REPLY', text }));
  if (input.urlButton) buttons.push({ type: 'URL', text: input.urlButton.text, url: input.urlButton.url });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  return components;
}

/** Texto final de um template com as variáveis preenchidas (pré-visualização e histórico). */
export function renderTemplate(components: TemplateComponentDef[], params: { header?: string[]; body?: string[] }): string {
  const fill = (text: string, values: string[] = []) =>
    text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, i: string) => values[Number(i) - 1] ?? `{{${i}}}`);
  const parts: string[] = [];
  for (const c of components) {
    if (c.type === 'HEADER' && c.text) parts.push(`*${fill(c.text, params.header)}*`);
    if (c.type === 'BODY' && c.text) parts.push(fill(c.text, params.body));
    if (c.type === 'FOOTER' && c.text) parts.push(`_${c.text}_`);
    if (c.type === 'BUTTONS' && c.buttons?.length) parts.push(c.buttons.map((b) => `[ ${b.text} ]`).join(' '));
  }
  return parts.join('\n\n');
}

/** A Meta recusa parâmetros com quebra de linha, TAB ou mais de 4 espaços seguidos. */
export function sanitizeParam(v: string): string {
  return v.replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);
}

/**
 * Converte os valores das variáveis no formato de envio da Cloud API.
 * Lança erro se faltar valor para alguma variável.
 */
export function buildSendComponents(defs: TemplateComponentDef[], params: { header?: string[]; body?: string[] }): TemplateComponent[] {
  const out: TemplateComponent[] = [];
  const header = defs.find((c) => c.type === 'HEADER');
  const body = defs.find((c) => c.type === 'BODY');
  const hv = header?.format === 'TEXT' || (header && !header.format) ? templateVariables(header.text) : [];
  const bv = templateVariables(body?.text);
  const take = (values: string[] | undefined, n: number, where: string) => {
    const list = (values ?? []).slice(0, n).map((v) => sanitizeParam(String(v ?? '')));
    if (list.length < n || list.some((v) => !v)) throw badRequest(`${where}: preencha as ${n} variáveis do template.`);
    return list;
  };
  if (hv.length) out.push({ type: 'header', parameters: take(params.header, hv.length, 'Cabeçalho').map((text) => ({ type: 'text', text })) });
  if (bv.length) out.push({ type: 'body', parameters: take(params.body, bv.length, 'Texto').map((text) => ({ type: 'text', text })) });
  return out;
}

function wabaIdsFor(deps: Deps, fromNumbers: string[]): string[] {
  return [...new Set([...fromNumbers, deps.env.META_WABA_ID].filter(Boolean))];
}

/** Puxa todos os templates da(s) WABA(s) e atualiza o banco (status de aprovação). */
export async function syncTemplates(deps: Deps) {
  const numbers = await deps.db.phoneNumber.findMany({ select: { wabaId: true } });
  const wabas = wabaIdsFor(
    deps,
    numbers.map((n) => n.wabaId),
  );
  if (!wabas.length) throw badRequest('Nenhuma WABA configurada (cadastre um número ou defina META_WABA_ID).');
  const client = managementClient(deps);
  let total = 0;
  for (const wabaId of wabas) {
    let list;
    try {
      list = await client.listTemplates(wabaId);
    } catch (err) {
      throw badRequest(`Não foi possível listar os templates da WABA ${wabaId}: ${(err as Error).message}`);
    }
    const seen: string[] = [];
    for (const t of list) {
      const row = await deps.db.template.upsert({
        where: { wabaId_name_language: { wabaId, name: t.name, language: t.language } },
        create: {
          wabaId,
          metaId: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components as unknown as Prisma.InputJsonValue,
          rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
        },
        update: {
          metaId: t.id,
          category: t.category,
          status: t.status,
          components: t.components as unknown as Prisma.InputJsonValue,
          rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
          syncedAt: new Date(),
        },
      });
      seen.push(row.id);
    }
    // Excluídos na Meta: ficam no histórico, mas não podem mais ser usados.
    await deps.db.template.updateMany({ where: { wabaId, id: { notIn: seen } }, data: { status: 'DELETED' } });
    total += list.length;
  }
  log.info({ total }, 'Templates sincronizados');
  return { total };
}

export async function createTemplate(deps: Deps, input: CreateTemplateBody) {
  const wabaId = input.wabaId || deps.env.META_WABA_ID || (await deps.db.phoneNumber.findFirst())?.wabaId;
  if (!wabaId) throw badRequest('Nenhuma WABA configurada.');
  const components = buildTemplateComponents(input);
  const existing = await deps.db.template.findUnique({
    where: { wabaId_name_language: { wabaId, name: input.name, language: input.language } },
  });
  if (existing && existing.status !== 'DELETED') throw badRequest('Já existe um template com esse nome e idioma.');

  let res;
  try {
    res = await managementClient(deps).createTemplate(wabaId, {
      name: input.name,
      language: input.language,
      category: input.category,
      components,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw badRequest(`A Meta recusou o template: ${err.message}`);
    throw err;
  }
  const data = {
    metaId: res.id,
    category: res.category ?? input.category,
    status: res.status ?? 'PENDING',
    components: components as unknown as Prisma.InputJsonValue,
    rejectedReason: null,
    syncedAt: new Date(),
  };
  const row = await deps.db.template.upsert({
    where: { wabaId_name_language: { wabaId, name: input.name, language: input.language } },
    create: { wabaId, name: input.name, language: input.language, ...data },
    update: data,
  });
  log.info({ name: row.name, status: row.status }, 'Template enviado para aprovação');
  return row;
}
