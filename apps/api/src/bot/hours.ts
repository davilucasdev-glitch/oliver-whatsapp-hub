import { z } from 'zod';
import { zonedParts } from '../lib/time.js';

/** Horário de atendimento humano. days: 0 = domingo … 6 = sábado → ["09:00", "18:00"]. Dia ausente = fechado. */
export const businessHoursSchema = z.object({
  timezone: z.string().default('America/Sao_Paulo'),
  days: z.partialRecord(
    z.enum(['0', '1', '2', '3', '4', '5', '6']),
    z
      .tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])
      .refine(([a, b]) => a < b, 'o horário de fechamento precisa ser depois da abertura'),
  ),
  /** Datas fechadas (feriados), "AAAA-MM-DD" */
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  days: { 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: ['09:00', '13:00'] },
  closedDates: [],
};

export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const ymd = (p: { year: number; month: number; day: number }) =>
  `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

export function parseBusinessHours(raw: unknown): BusinessHours {
  const r = businessHoursSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_BUSINESS_HOURS;
}

export function isOpenAt(date: Date, h: BusinessHours): boolean {
  const p = zonedParts(date, h.timezone);
  if (h.closedDates.includes(ymd(p))) return false;
  const range = h.days[String(p.weekday) as keyof BusinessHours['days']];
  if (!range) return false;
  const now = p.hour * 60 + p.minute;
  return now >= toMin(range[0]) && now < toMin(range[1]);
}

/** Próxima abertura em texto ("hoje às 09:00", "amanhã às 09:00", "segunda às 09:00"), ou null se nunca abre. */
export function nextOpening(date: Date, h: BusinessHours): string | null {
  const start = zonedParts(date, h.timezone);
  const nowMin = start.hour * 60 + start.minute;
  for (let offset = 0; offset < 15; offset++) {
    const d = zonedParts(new Date(date.getTime() + offset * 86_400_000), h.timezone);
    if (h.closedDates.includes(ymd(d))) continue;
    const range = h.days[String(d.weekday) as keyof BusinessHours['days']];
    if (!range) continue;
    if (offset === 0 && nowMin >= toMin(range[0])) continue; // hoje já abriu (ou já fechou)
    const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : `${WEEKDAYS[d.weekday]} (${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')})`;
    return `${when} às ${range[0]}`;
  }
  return null;
}

/** Ex.: "seg a sex 09:00–18:00; sáb 09:00–13:00" */
export function describeHours(h: BusinessHours): string {
  const short = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const parts: { days: number[]; range: string }[] = [];
  for (let d = 0; d < 7; d++) {
    const r = h.days[String(d) as keyof BusinessHours['days']];
    if (!r) continue;
    const range = `${r[0]}–${r[1]}`;
    const last = parts.at(-1);
    if (last && last.range === range && last.days.at(-1) === d - 1) last.days.push(d);
    else parts.push({ days: [d], range });
  }
  if (!parts.length) return 'sem atendimento humano configurado';
  return parts
    .map((p) => {
      const first = short[p.days[0]!]!;
      const label = p.days.length === 1 ? first : `${first} a ${short[p.days.at(-1)!]}`;
      return `${label} ${p.range}`;
    })
    .join('; ');
}
