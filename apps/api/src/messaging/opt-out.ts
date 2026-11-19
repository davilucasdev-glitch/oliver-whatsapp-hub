/**
 * Detecção de opt-out / opt-in por palavra-chave.
 *
 * Para não confundir "quero cancelar meu pedido" (atendimento) com descadastro,
 * só conta como opt-out quando a mensagem é a própria palavra-chave ou uma frase
 * curta claramente de descadastro ("quero sair", "parar de receber", "me tira da lista").
 */

export type ConsentIntent = 'OPT_OUT' | 'OPT_IN' | null;

const OPT_OUT_EXACT = new Set([
  'sair',
  'parar',
  'pare',
  'cancelar',
  'stop',
  'descadastrar',
  'descadastro',
  'remover',
  'unsubscribe',
  'nao quero mais',
  'nao quero receber',
  'nao me mande mais',
  'nao mande mais',
  // botão "Parar promoções" que os templates de marketing incluem
  'parar promocoes',
  'parar promocao',
  'sair da lista',
]);

const OPT_OUT_PATTERNS: RegExp[] = [
  /^(quero|pode|por favor|pfv|pf)?\s*(me\s+)?(sair|parar|descadastrar|remover)(\s+(da|dessa|desta|de)\s+(lista|campanha|campanhas|mensagens?))?$/,
  /^(parar|pare|parem|para)\s+de\s+(me\s+)?(mandar|enviar|receber)(\s+(mensagens?|promocoes|propagandas?|isso))?$/,
  /^(me\s+)?(tira|tirem|remove|removam|exclui|excluam)\s+(da|dessa|desta)\s+lista$/,
  /^cancelar\s+(inscricao|cadastro|mensagens?|promocoes|lista|campanhas?)$/,
  /^nao\s+quero\s+(mais\s+)?receber(\s+(mensagens?|promocoes|propagandas?|isso))?$/,
];

const OPT_IN_EXACT = new Set(['voltar', 'assinar', 'quero receber', 'quero voltar', 'receber promocoes']);

export function normalizeForKeywords(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // pontuação e emojis viram espaço
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectConsentIntent(text: string | null | undefined): ConsentIntent {
  if (!text) return null;
  const t = normalizeForKeywords(text);
  if (!t || t.split(' ').length > 8) return null;
  if (OPT_OUT_EXACT.has(t) || OPT_OUT_PATTERNS.some((re) => re.test(t))) return 'OPT_OUT';
  if (OPT_IN_EXACT.has(t)) return 'OPT_IN';
  return null;
}

export const OPT_OUT_CONFIRMATION =
  'Pronto! Você não vai mais receber nossas campanhas e promoções por aqui. ' +
  'Se mudar de ideia, é só mandar VOLTAR. E pode continuar falando com a gente quando quiser 😊';

export const OPT_IN_CONFIRMATION =
  'Que bom ter você de volta! Você voltará a receber nossas novidades por aqui. Para parar, é só mandar SAIR.';
