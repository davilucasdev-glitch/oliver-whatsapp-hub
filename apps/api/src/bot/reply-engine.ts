import type { Deps } from '../deps.js';
import { sendTextMessage } from '../messaging/outbound.js';

export interface ReplyContext {
  conversationId: string;
  contactName: string | null;
  text: string | null;
  messageType: string;
  inboundWaMessageId: string;
}

/** Quem responde quando a conversa está com o bot. */
export interface ReplyEngine {
  readonly name: string;
  reply(deps: Deps, ctx: ReplyContext): Promise<void>;
}

/**
 * Etapa 1: resposta fixa para validar o circuito webhook → fila → envio.
 * Substituída pelo bot de IA (BOT_MODE=ai) na etapa 5.
 */
export const echoReplyEngine: ReplyEngine = {
  name: 'echo',
  async reply(deps, ctx) {
    const first = ctx.contactName?.split(' ')[0];
    const greeting = first ? `Olá, ${first}! 👋` : 'Olá! 👋';
    const received = ctx.text ? `Recebemos sua mensagem: "${ctx.text.slice(0, 200)}"` : `Recebemos sua mensagem (${ctx.messageType}).`;
    await sendTextMessage(deps, {
      conversationId: ctx.conversationId,
      sentBy: 'BOT',
      body: `${greeting} ${received}\n\n(Resposta automática de teste do Oliver WhatsApp Hub.)`,
    });
  },
};

export const silentReplyEngine: ReplyEngine = {
  name: 'off',
  async reply() {
    /* BOT_MODE=off: só registra as mensagens, sem responder */
  },
};
