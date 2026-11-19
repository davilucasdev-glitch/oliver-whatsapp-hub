import { WhatsAppApiError } from '../whatsapp/provider.js';

/**
 * O que fazer quando a Meta recusa um envio de campanha.
 *  - throttle: a Meta pediu para desacelerar → devolve o contato para a fila e espera.
 *  - number: problema no número/conta (spam, bloqueio, pagamento, token) → pausa TODAS as campanhas do número.
 *  - template: template pausado/desativado/com variáveis erradas → pausa esta campanha.
 *  - recipient: problema só com este contato → marca falha e segue.
 *  - transient: instabilidade (5xx/rede) → tenta de novo mais tarde.
 */
export type SendErrorKind = 'throttle' | 'number' | 'template' | 'recipient' | 'transient';

export interface ClassifiedError {
  kind: SendErrorKind;
  code: string;
  message: string;
  /** o cliente bloqueou mensagens de marketing no próprio WhatsApp: tratar como opt-out */
  optOut?: boolean;
}

const THROTTLE = new Set([4, 80007, 130429, 131056]);

const NUMBER_ERRORS: Record<number, string> = {
  131048: 'A Meta limitou os envios deste número por excesso de denúncias/spam',
  368: 'A Meta bloqueou temporariamente o número por violação de política',
  131031: 'A conta do WhatsApp Business está bloqueada',
  131042: 'Problema de pagamento na conta da Meta',
  190: 'Token da Meta inválido ou expirado',
  133010: 'O número não está registrado na Cloud API',
  131045: 'Certificado do número inválido',
};

const TEMPLATE_ERRORS: Record<number, string> = {
  132000: 'A quantidade de variáveis não bate com o template',
  132001: 'O template não existe na Meta (ou nesse idioma)',
  132005: 'O texto final do template ficou longo demais',
  132007: 'O conteúdo do template viola a política da Meta',
  132012: 'Formato de variável inválido para o template',
  132015: 'O template foi pausado pela Meta (baixa qualidade)',
  132016: 'O template foi desativado pela Meta',
  132068: 'O template foi bloqueado',
};

const RECIPIENT_ERRORS: Record<number, string> = {
  131026: 'Não foi possível entregar (número sem WhatsApp, app desatualizado ou não aceitou os termos)',
  131049: 'A Meta não entregou para não sobrecarregar o cliente com marketing (limite por pessoa)',
  131050: 'O cliente bloqueou mensagens de marketing no WhatsApp',
  131047: 'Fora da janela de 24h (só template pode ser enviado)',
  131051: 'Tipo de mensagem não suportado',
  131052: 'Não foi possível baixar a mídia do cabeçalho',
  131053: 'Não foi possível enviar a mídia do cabeçalho (link inválido ou arquivo grande)',
  470: 'Fora da janela de 24h',
  1013: 'Número de destino inválido',
  131021: 'O destinatário é o próprio número de envio',
};

export function classifyMetaCode(code: number | string | undefined, status = 400, fallback = 'Erro da Meta'): ClassifiedError {
  const n = Number(code);
  const c = code !== undefined && Number.isFinite(n) ? String(n) : String(status);
  if (THROTTLE.has(n) || status === 429) return { kind: 'throttle', code: c, message: 'A Meta pediu para diminuir o ritmo de envio' };
  if (NUMBER_ERRORS[n]) return { kind: 'number', code: c, message: NUMBER_ERRORS[n] };
  if (status === 401) return { kind: 'number', code: c, message: NUMBER_ERRORS[190]! };
  if (TEMPLATE_ERRORS[n]) return { kind: 'template', code: c, message: TEMPLATE_ERRORS[n] };
  if (RECIPIENT_ERRORS[n]) return { kind: 'recipient', code: c, message: RECIPIENT_ERRORS[n], ...(n === 131050 ? { optOut: true } : {}) };
  if (status >= 500 || n === 131000 || n === 131016 || n === 2) return { kind: 'transient', code: c, message: 'A Meta está instável no momento' };
  return { kind: 'recipient', code: c, message: fallback.slice(0, 300) };
}

export function classifySendError(err: unknown): ClassifiedError {
  if (err instanceof WhatsAppApiError) return classifyMetaCode(err.code, err.status, err.message);
  const msg = (err as Error)?.message ?? String(err);
  // erro de rede = instabilidade; qualquer outro erro local = problema com este contato/campanha
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket|network/i.test(msg)) return { kind: 'transient', code: 'REDE', message: 'Sem conexão com a Meta' };
  return { kind: 'recipient', code: 'LOCAL', message: msg.slice(0, 300) };
}
