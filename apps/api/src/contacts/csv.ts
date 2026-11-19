/**
 * Leitor de CSV sem dependências: aspas, aspas escapadas (""), quebras de linha dentro de aspas,
 * BOM do Excel e detecção automática de separador (; ou , ou TAB — o Excel em português usa ;).
 */
export function detectDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ',';
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Normaliza cabeçalho: "Opt-in", "opt in", "OPTIN" → "optin"; "Telefone/WhatsApp" → "telefonewhatsapp". */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export const HEADER_ALIASES: Record<'name' | 'phone' | 'tags' | 'optIn' | 'email', string[]> = {
  name: ['nome', 'name', 'cliente', 'nomecompleto', 'contato'],
  phone: ['telefone', 'phone', 'celular', 'whatsapp', 'fone', 'numero', 'telefonewhatsapp', 'tel'],
  tags: ['tags', 'tag', 'etiquetas', 'segmento', 'segmentos', 'grupos'],
  optIn: ['optin', 'consentimento', 'aceitamarketing', 'aceita', 'autorizou', 'permissao'],
  email: ['email', 'e-mail', 'mail'],
};

/** "sim", "s", "x", "true", "1", "yes" → true; "não", "n", "false", "0", "" → false; resto → null (inválido). */
export function parseBool(raw: string | undefined): boolean | null {
  const v = normalizeHeader(raw ?? '');
  if (['sim', 's', 'x', 'true', '1', 'yes', 'y', 'ok'].includes(v)) return true;
  if (['nao', 'n', 'false', '0', 'no', ''].includes(v)) return false;
  return null;
}

export function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[|,;/]/).map((t) => t.trim()).filter(Boolean))].map((t) => t.slice(0, 50));
}
