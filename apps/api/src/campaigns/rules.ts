import type { Contact, PhoneNumber } from '@prisma/client';
import { isE164 } from '../lib/phone.js';
import { zonedParts, zonedToUtc } from '../lib/time.js';

/** Regras anti-bloqueio das campanhas (funções puras, testadas em rules.test.ts). */

/** Nunca de madrugada: a janela de envio precisa ficar entre 8h e 21h. */
export const WINDOW_MIN_HOUR = 8;
export const WINDOW_MAX_HOUR = 21;

/** Parte do limite diário (tier) que as campanhas podem usar — sobra espaço para o atendimento. */
export const DAILY_LIMIT_SHARE = 0.9;

/** Resposta do cliente até X dias depois do envio conta como "respondeu à campanha". */
export const REPLY_ATTRIBUTION_DAYS = 3;

/** Depois de 20 tentativas, mais de 30% de falha pausa a campanha (sinal de lista ruim). */
export const FAILURE_PAUSE_MIN_ATTEMPTS = 20;
export const FAILURE_PAUSE_RATE = 0.3;

export function validateWindow(start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'Horários inválidos.';
  if (start < WINDOW_MIN_HOUR) return `A janela não pode começar antes das ${WINDOW_MIN_HOUR}h.`;
  if (end > WINDOW_MAX_HOUR) return `A janela não pode terminar depois das ${WINDOW_MAX_HOUR}h.`;
  if (end - start < 1) return 'A janela precisa ter pelo menos 1 hora.';
  return null;
}

/** Dentro da janela [start, end) no fuso da campanha. */
export function isWithinWindow(now: Date, tz: string, start: number, end: number): boolean {
  const h = zonedParts(now, tz).hour;
  return h >= start && h < end;
}

/** Próximo início de janela (hoje, se ainda não começou; senão amanhã). */
export function nextWindowStart(now: Date, tz: string, start: number): Date {
  const p = zonedParts(now, tz);
  const today = zonedToUtc(p.year, p.month, p.day, start, 0, tz);
  return today > now ? today : zonedToUtc(p.year, p.month, p.day + 1, start, 0, tz);
}

/** Intervalo entre envios do número, em ms (ritmo efetivo, já reduzido se a qualidade caiu). */
export function sendIntervalMs(ratePerMinute: number): number {
  return Math.ceil(60_000 / Math.max(1, ratePerMinute));
}

/**
 * Ritmo por número: cada envio "reserva" o próximo horário liberado.
 * Se o número ficou parado, recomeça de agora (sem rajada acumulada); um atraso pequeno
 * (até `catchUpMs`) é compensado para o ritmo médio bater com o configurado.
 * Devolve null se ainda não é hora de enviar.
 */
export function nextSlot(current: Date | null, now: Date, intervalMs: number, catchUpMs: number): Date | null {
  if (current && current > now) return null;
  const base = current && current.getTime() > now.getTime() - catchUpMs ? current : now;
  return new Date(base.getTime() + intervalMs);
}

export function dailyCap(number: Pick<PhoneNumber, 'dailyConversationLimit'>): number {
  return Math.max(1, Math.floor(number.dailyConversationLimit * DAILY_LIMIT_SHARE));
}

export type SkipReason = 'opt-out' | 'sem opt-in' | 'frequência' | 'telefone inválido';

export const SKIP_LABEL: Record<string, string> = {
  'opt-out': 'Pediu para não receber (opt-out)',
  'sem opt-in': 'Sem autorização de marketing (opt-in)',
  frequência: 'Recebeu outra campanha recentemente',
  'telefone inválido': 'Telefone inválido',
  'campanha cancelada': 'Campanha cancelada antes do envio',
};

/** Por que este contato NÃO pode receber a campanha agora (null = pode). */
export function skipReasonFor(
  c: Pick<Contact, 'phone' | 'optIn' | 'optOut' | 'lastCampaignAt'>,
  now: Date,
  minDaysBetween: number,
): SkipReason | null {
  if (c.optOut) return 'opt-out';
  if (!c.optIn) return 'sem opt-in';
  if (!isE164(c.phone)) return 'telefone inválido';
  if (minDaysBetween > 0 && c.lastCampaignAt && now.getTime() - c.lastCampaignAt.getTime() < minDaysBetween * 86_400_000) return 'frequência';
  return null;
}

/**
 * Estimativa de duração: ritmo × horas de janela por dia × limite diário.
 * Ex.: 1.000 contatos a 20/min numa janela de 11h = 50 min, no mesmo dia.
 */
export function estimateDuration(eligible: number, ratePerMinute: number, windowHours: number, cap: number) {
  const perDayByRate = Math.max(1, ratePerMinute) * 60 * windowHours;
  const perDay = Math.min(perDayByRate, cap);
  const days = eligible === 0 ? 0 : Math.ceil(eligible / perDay);
  const minutes = eligible === 0 ? 0 : Math.ceil(Math.min(eligible, perDay) / Math.max(1, ratePerMinute));
  return { perDay, days, minutesFirstDay: minutes, limitedBy: perDayByRate > cap ? ('limite diário' as const) : ('ritmo' as const) };
}
