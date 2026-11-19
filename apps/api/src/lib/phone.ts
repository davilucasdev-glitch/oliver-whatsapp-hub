/**
 * Normalização de telefones para E.164 com foco no Brasil (+55).
 * Aceita "(11) 99999-9999", "11999999999", "5511999999999", "+55 11 9 9999-9999".
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export function normalizePhone(raw: string, defaultCountry = '55'): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (!hasPlus) {
    digits = digits.replace(/^0+/, ''); // remove 0 de operadora/DDD
    // Número brasileiro sem DDI: 10 (fixo) ou 11 (celular) dígitos
    if (defaultCountry === '55' && (digits.length === 10 || digits.length === 11)) {
      digits = `55${digits}`;
    }
    // Sem "+", só aceitamos números do país padrão; internacionais precisam vir com "+".
    if (!digits.startsWith(defaultCountry)) return null;
  }

  if (digits.startsWith('55')) {
    const national = digits.slice(2);
    // DDD 11–99 + 8 ou 9 dígitos
    if (!/^[1-9][1-9]\d{8,9}$/.test(national)) return null;
    // Celular com 9 dígitos precisa começar com 9
    if (national.length === 11 && national[2] !== '9') return null;
  }

  const e164 = `+${digits}`;
  return isE164(e164) ? e164 : null;
}

/** wa_id da Meta vem sem "+": "5511999999999" -> "+5511999999999". */
export function waIdToE164(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  return `+${digits}`;
}

/** Para a API da Meta: "+5511999999999" -> "5511999999999". */
export function e164ToWaRecipient(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** Remove duplicados e inválidos mantendo a ordem. */
export function dedupePhones(raws: string[]): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of raws) {
    const n = normalizePhone(raw);
    if (!n) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(n)) {
      seen.add(n);
      valid.push(n);
    }
  }
  return { valid, invalid };
}
