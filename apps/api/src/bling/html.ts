/**
 * Converte a descrição HTML do Bling em texto limpo para a IA e para busca.
 * Precisa aguentar HTML colado de outros sites (estilos, atributos enormes, comentários,
 * e até tags "escapadas" como &lt;a href=...&gt;), sem depender de biblioteca externa.
 */

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', bull: '•', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', ordm: 'º', ordf: 'ª', euro: '€', cent: '¢', times: '×',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï', Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Ccedil: 'Ç', Ntilde: 'Ñ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[code] ?? m;
  });
}

const BLOCK = /<\/?(p|div|h[1-6]|ul|ol|table|tr|section|article|header|footer|blockquote)\b[^>]*>/gi;

function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '');
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let text = decodeEntities(stripTags(html));
  // HTML que veio "escapado" dentro do texto (&lt;a ...&gt;) vira tag depois de decodificar: limpa de novo.
  if (/<[a-z!/][^>]*>/i.test(text)) text = decodeEntities(stripTags(text));
  return text
    .replace(/\r/g, '')
    .replace(/\[(\s*\d+\s*,?)+\]/g, '') // marcadores de citação colados de buscadores: [1, 2]
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== '•')
    .join('\n')
    .trim();
}

/** minúsculo, sem acento e sem pontuação — para busca aproximada. */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Primeira frase/linha útil da descrição (depois do título). */
export function firstSentence(text: string, max = 220): string | null {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('•'));
  const line = lines.find((l, i) => i > 0 && l.length > 30) ?? lines[0];
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Deduz o gênero pela ficha ("Gênero: Feminino"), categoria ou nome (MASC/FEM). */
export function detectGender(text: string, category: string | null, name: string): string | null {
  const ficha = /g[eê]nero:\s*([a-zà-ú]+)/i.exec(text)?.[1];
  const sources = [ficha, category, name].filter(Boolean).map((s) => normalizeSearch(s!));
  for (const s of sources) {
    if (/\bunissex|\bunisex|\bcompartilhavel/.test(s)) return 'unissex';
    if (/\bfem(inin[oa]s?)?\b|\bwoman\b|\bwomen\b|\bpour femme\b/.test(s)) return 'feminino';
    if (/\bmasc(ulin[oa]s?)?\b|\bman\b|\bmen\b|\bpour homme\b/.test(s)) return 'masculino';
    if (/\binfantil\b|\bkids?\b/.test(s)) return 'infantil';
  }
  return null;
}
