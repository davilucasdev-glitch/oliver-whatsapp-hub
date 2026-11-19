import type { ChargeKind, PrismaClient } from '@prisma/client';
import { getSetting, setSetting } from '../settings.js';

/**
 * Cobrança e crediário (documento da Ellen, seção "Cobrança e crediário"):
 * lembrete 2 dias antes, vence hoje, parcela em atraso e pagamento recebido.
 * Nada sai sozinho: cada envio é um clique de alguém da equipe na tela Cobrança.
 */

export const CHARGE_KINDS = ['LEMBRETE', 'VENCE_HOJE', 'ATRASO', 'PAGAMENTO'] as const satisfies readonly ChargeKind[];
export type ChargeKindKey = (typeof CHARGE_KINDS)[number];

export interface ChargeKindInfo {
  label: string;
  when: string;
  vars: string[];
  suggested: { name: string; body: string; examples: string[] };
}

export const CHARGE_INFO: Record<ChargeKindKey, ChargeKindInfo> = {
  LEMBRETE: {
    label: 'Lembrete de parcela',
    when: '2 dias antes do vencimento',
    vars: ['primeiro nome', 'valor', 'data do vencimento', 'chave Pix'],
    suggested: {
      name: 'cobranca_lembrete',
      body: 'Oi, {{1}}! Passando para lembrar que a sua parcela de {{2}} na Oliver Cosméticos vence em {{3}}. Se preferir, pague pelo Pix: {{4}}. Depois é só mandar o comprovante por aqui.',
      examples: ['Maria', 'R$ 278,00', '20/11', 'pix@exemplo.com.br'],
    },
  },
  VENCE_HOJE: {
    label: 'Vence hoje',
    when: 'No dia do vencimento',
    vars: ['primeiro nome', 'valor', 'chave Pix'],
    suggested: {
      name: 'cobranca_vence_hoje',
      body: 'Oi, {{1}}! A sua parcela de {{2}} na Oliver Cosméticos vence hoje. Chave Pix: {{3}}. Depois de pagar, é só mandar o comprovante por aqui.',
      examples: ['Maria', 'R$ 278,00', 'pix@exemplo.com.br'],
    },
  },
  ATRASO: {
    label: 'Parcela em aberto',
    when: 'Vencida (aparece em "Quem cobrar")',
    vars: ['primeiro nome', 'valor em atraso', 'tempo de atraso', 'saldo total no crediário'],
    suggested: {
      name: 'cobranca_em_aberto',
      body: 'Oi, {{1}}, tudo bem? Consta na Oliver Cosméticos uma parcela em aberto de {{2}}, vencida há {{3}}. Seu saldo total no crediário é {{4}}. Se já pagou, é só mandar o comprovante aqui que a gente confere.',
      examples: ['Maria', 'R$ 278,00', '5 dias', 'R$ 834,00'],
    },
  },
  PAGAMENTO: {
    label: 'Pagamento recebido',
    when: 'Depois da baixa da conta no Bling',
    vars: ['primeiro nome', 'valor pago', 'saldo que ficou'],
    suggested: {
      name: 'cobranca_pagamento_recebido',
      body: 'Oi, {{1}}! Recebemos o seu pagamento de {{2}}. Obrigada! Seu saldo no crediário da Oliver Cosméticos agora é {{3}}.',
      examples: ['Maria', 'R$ 278,00', 'R$ 556,00'],
    },
  },
};

export interface ChargeConfig {
  pixKey: string;
  /** Contas emitidas antes desta data não entram (mesmo corte do painel). */
  cutoff: string;
  reminderDays: number;
  /** Quem fica responsável pelas conversas de cobrança (a Ellen, pelo documento). */
  ownerUserId: string | null;
  phoneNumberId: string | null;
  templates: Record<ChargeKindKey, string>;
}

export const TIKTOK_STORE_ID = '206093178';
const KEY = 'charges.config';
const SYNC_KEY = 'charges.sync';

export function defaultChargeConfig(): ChargeConfig {
  return {
    pixKey: '',
    cutoff: '2026-10-01',
    reminderDays: 2,
    ownerUserId: null,
    phoneNumberId: null,
    templates: Object.fromEntries(CHARGE_KINDS.map((k) => [k, CHARGE_INFO[k].suggested.name])) as ChargeConfig['templates'],
  };
}

export async function getChargeConfig(db: PrismaClient): Promise<ChargeConfig> {
  const saved = await getSetting<Partial<ChargeConfig> | null>(db, KEY, null);
  const base = defaultChargeConfig();
  return saved ? { ...base, ...saved, templates: { ...base.templates, ...saved.templates } } : base;
}

export async function saveChargeConfig(db: PrismaClient, cfg: ChargeConfig): Promise<void> {
  await setSetting(db, KEY, cfg);
}

export interface ChargeSyncState {
  lastSyncAt: string | null;
  lastError: string | null;
  open: number;
  /** contas parcialmente pagas em que o Bling não informou quanto falta */
  unknownRemaining: number;
}

export async function getChargeSyncState(db: PrismaClient): Promise<ChargeSyncState> {
  return getSetting<ChargeSyncState>(db, SYNC_KEY, { lastSyncAt: null, lastError: null, open: 0, unknownRemaining: 0 });
}

export async function saveChargeSyncState(db: PrismaClient, st: ChargeSyncState): Promise<void> {
  await setSetting(db, SYNC_KEY, st);
}

/** "AAAA-MM-DD" de hoje (ou de outra data) no horário de Brasília. */
export function spDate(d = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
}

export const money = (v: number) => Math.round(v * 100) / 100;
