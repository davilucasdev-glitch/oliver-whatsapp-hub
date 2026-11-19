import type { Contact, Product } from '@prisma/client';
import { z } from 'zod';
import { templateVariables } from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';

/**
 * De onde vem cada variável {{n}} do template, por contato.
 * Personalizar (nome do cliente) evita milhares de mensagens idênticas — boa prática anti-bloqueio.
 */
export const variableSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('firstName'), fallback: z.string().trim().min(1).max(60).default('cliente') }),
  z.object({ source: z.literal('fullName'), fallback: z.string().trim().min(1).max(60).default('cliente') }),
  z.object({ source: z.literal('text'), value: z.string().trim().min(1, 'preencha o texto da variável').max(1000) }),
  z.object({ source: z.literal('product'), productId: z.string().min(1, 'escolha o produto'), field: z.enum(['name', 'price']) }),
]);

export type VariableSource = z.infer<typeof variableSourceSchema>;

export const variableMapSchema = z.object({
  header: z.array(variableSourceSchema).default([]),
  body: z.array(variableSourceSchema).default([]),
});

export type VariableMap = z.infer<typeof variableMapSchema>;

const CONNECTORS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

function titleCase(word: string): string {
  return word
    .toLowerCase()
    .split('-')
    .map((w) => (CONNECTORS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('-');
}

/** "MARIA DA SILVA" → "Maria"; nomes estranhos ("Loja 123", emoji) viram null. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  if (!/^\p{L}[\p{L}'-]{1,29}$/u.test(first)) return null;
  return titleCase(first);
}

export function fullName(name: string | null | undefined): string | null {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!words.length || !words.every((w) => /^\p{L}[\p{L}'.-]*$/u.test(w))) return null;
  return words.slice(0, 4).map(titleCase).join(' ');
}

export const money = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');

export type ProductLookup = Map<string, Pick<Product, 'id' | 'name' | 'price' | 'active'>>;

export function resolveVariable(v: VariableSource, contact: Pick<Contact, 'name'>, products: ProductLookup): string {
  switch (v.source) {
    case 'firstName':
      return firstName(contact.name) ?? v.fallback;
    case 'fullName':
      return fullName(contact.name) ?? v.fallback;
    case 'text':
      return v.value;
    case 'product': {
      const p = products.get(v.productId);
      if (!p) throw new Error('O produto escolhido para a variável não existe mais no catálogo');
      return v.field === 'name' ? p.name : money(Number(p.price));
    }
  }
}

export function resolveAll(map: VariableMap, contact: Pick<Contact, 'name'>, products: ProductLookup) {
  return {
    header: map.header.map((v) => resolveVariable(v, contact, products)),
    body: map.body.map((v) => resolveVariable(v, contact, products)),
  };
}

export function productIdsOf(map: VariableMap): string[] {
  return [...new Set([...map.header, ...map.body].flatMap((v) => (v.source === 'product' ? [v.productId] : [])))];
}

export type HeaderMediaFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

/** Quantas variáveis o template tem e se o cabeçalho é de mídia. */
export function templateShape(defs: TemplateComponentDef[]) {
  const header = defs.find((c) => c.type === 'HEADER');
  const body = defs.find((c) => c.type === 'BODY');
  const media = header?.format && header.format !== 'TEXT' ? (header.format as HeaderMediaFormat) : null;
  return {
    headerVars: media ? 0 : templateVariables(header?.text).length,
    bodyVars: templateVariables(body?.text).length,
    headerMedia: media,
  };
}
