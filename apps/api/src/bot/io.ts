import type { Message, Prisma } from '@prisma/client';
import type { Deps } from '../deps.js';
import { sendMediaMessage, sendTextMessage } from '../messaging/outbound.js';

/**
 * Entrada/saída do bot. A mesma lógica atende a conversa real (WhatsApp) e o simulador do painel;
 * só muda para onde vão as respostas e de onde vem o histórico.
 */

export interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface CustomerInfo {
  name: string | null;
  phone: string;
  document: string | null;
  blingContactId: string | null;
}

export interface Memory {
  summary: string | null;
  /** últimas mensagens (no máximo MEMORY_WINDOW), em ordem */
  recent: HistoryItem[];
  /** mensagens mais antigas que ainda não entraram no resumo */
  pendingOlder: HistoryItem[];
  commitSummary(summary: string): Promise<void>;
}

export interface BotLogInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolsCalled: Prisma.InputJsonValue;
  replyText: string | null;
  latencyMs: number;
  error: string | null;
  iterations: number;
  stopReason: string | null;
  handoff: boolean;
}

export interface BotIO {
  readonly simulated: boolean;
  customer(): Promise<CustomerInfo>;
  memory(): Promise<Memory>;
  sendText(text: string): Promise<void>;
  sendImage(url: string, caption: string): Promise<void>;
  handoff(reason: string): Promise<void>;
  failedAttempts(): Promise<number>;
  setFailedAttempts(n: number): Promise<void>;
  /** grava o CPF/CNPJ que o cliente informou (quando confirmou um pedido) */
  saveDocument(doc: string, blingContactId: string | null): Promise<void>;
  log(data: BotLogInput): Promise<void>;
}

export const MEMORY_WINDOW = 20;
/** só resume quando juntar pelo menos isto de mensagens antigas (economiza chamadas) */
export const SUMMARY_BATCH = 10;

const MEDIA_LABEL: Record<string, string> = {
  image: 'uma foto',
  video: 'um vídeo',
  audio: 'um áudio',
  voice: 'um áudio',
  document: 'um documento',
  sticker: 'uma figurinha',
  location: 'uma localização',
  contacts: 'um contato',
};

/** Mensagem do banco → item do histórico do modelo. */
export function messageToHistory(m: Pick<Message, 'direction' | 'type' | 'body' | 'sentBy' | 'templateName'>): HistoryItem | null {
  const body = m.body?.trim() ?? '';
  if (m.direction === 'INBOUND') {
    if (m.type === 'reaction') return null;
    if (m.type === 'text' || m.type === 'button' || m.type === 'interactive') return body ? { role: 'user', text: body } : null;
    const label = MEDIA_LABEL[m.type] ?? `uma mensagem do tipo ${m.type}`;
    return { role: 'user', text: body ? `[o cliente enviou ${label} com a legenda: ${body}]` : `[o cliente enviou ${label}]` };
  }
  const media = m.type !== 'text' && m.type !== 'template' ? `[foto/arquivo enviado${body ? `: ${body}` : ''}]` : null;
  const text = media ?? body;
  if (!text) return null;
  switch (m.sentBy) {
    case 'HUMAN':
      return { role: 'assistant', text: `(mensagem do atendente humano) ${text}` };
    case 'CAMPAIGN':
      return { role: 'assistant', text: `(mensagem de campanha${m.templateName ? ` ${m.templateName}` : ''}) ${text}` };
    case 'SYSTEM':
      return { role: 'assistant', text: `(mensagem automática) ${text}` };
    default:
      return { role: 'assistant', text };
  }
}

// ── Conversa real (WhatsApp) ──

export function conversationIO(deps: Deps, conversationId: string, inboundMessageId: string | null): BotIO {
  const { db } = deps;
  const load = () => db.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { contact: true } });

  return {
    simulated: false,
    async customer() {
      const c = (await load()).contact;
      return { name: c.name, phone: c.phone, document: c.document, blingContactId: c.blingContactId };
    },
    async memory() {
      const conv = await load();
      const recentRows = (await db.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: MEMORY_WINDOW })).reverse();
      const oldestRecent = recentRows[0];
      let pendingRows: Message[] = [];
      if (oldestRecent) {
        const upTo = conv.summaryUpToId ? await db.message.findUnique({ where: { id: conv.summaryUpToId }, select: { createdAt: true } }) : null;
        pendingRows = await db.message.findMany({
          where: { conversationId, createdAt: { lt: oldestRecent.createdAt, ...(upTo ? { gt: upTo.createdAt } : {}) } },
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
      }
      const toItems = (rows: Message[]) => rows.map(messageToHistory).filter((x): x is HistoryItem => x !== null);
      return {
        summary: conv.summary,
        recent: toItems(recentRows),
        pendingOlder: toItems(pendingRows),
        async commitSummary(summary) {
          const last = pendingRows.at(-1);
          if (last) await db.conversation.update({ where: { id: conversationId }, data: { summary, summaryUpToId: last.id } });
        },
      };
    },
    async sendText(text) {
      await sendTextMessage(deps, { conversationId, sentBy: 'BOT', body: text });
      // O aviso de transferência não conta como atendimento: a conversa continua em "aguardando resposta".
      await db.conversation.updateMany({ where: { id: conversationId, handler: 'HUMAN' }, data: { awaitingReply: true } });
    },
    async sendImage(url, caption) {
      await sendMediaMessage(deps, { conversationId, sentBy: 'BOT', kind: 'image', link: url, caption });
    },
    async handoff(reason) {
      const conv = await db.conversation.update({
        where: { id: conversationId },
        data: { handler: 'HUMAN', handoffReason: reason.slice(0, 300), handoffAt: new Date(), botFailedAttempts: 0 },
        include: { contact: true },
      });
      await db.alert.create({
        data: {
          level: 'WARNING',
          type: 'HANDOFF',
          message: `${conv.contact.name ?? conv.contact.phone} precisa de um atendente: ${reason.slice(0, 200)}`,
          phoneNumberId: conv.phoneNumberId,
          meta: { conversationId },
        },
      });
    },
    async failedAttempts() {
      return (await load()).botFailedAttempts;
    },
    async setFailedAttempts(n) {
      await db.conversation.update({ where: { id: conversationId }, data: { botFailedAttempts: n } });
    },
    async saveDocument(doc, blingContactId) {
      const c = (await load()).contact;
      const data: Prisma.ContactUpdateInput = {};
      if (!c.document) data.document = doc;
      if (!c.blingContactId && blingContactId) {
        const taken = await db.contact.findFirst({ where: { blingContactId }, select: { id: true } });
        if (!taken) data.blingContactId = blingContactId;
      }
      if (Object.keys(data).length) await db.contact.update({ where: { id: c.id }, data });
    },
    async log(data) {
      await db.botLog.create({ data: { ...data, conversationId, inboundMessageId } });
    },
  };
}

// ── Simulador do painel ──

export interface SimMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  imageUrl?: string;
  at: string;
}

export function simMessages(raw: Prisma.JsonValue): SimMessage[] {
  return Array.isArray(raw) ? (raw as unknown as SimMessage[]) : [];
}

export function simIO(deps: Deps, sessionId: string): BotIO {
  const { db } = deps;
  const load = () => db.botSimSession.findUniqueOrThrow({ where: { id: sessionId } });
  const push = async (m: Omit<SimMessage, 'at'>) => {
    const s = await load();
    const list = [...simMessages(s.messages), { ...m, at: new Date().toISOString() }];
    await db.botSimSession.update({ where: { id: sessionId }, data: { messages: list as unknown as Prisma.InputJsonValue } });
  };
  const toItem = (m: SimMessage): HistoryItem | null => {
    if (m.role === 'user') return { role: 'user', text: m.text };
    if (m.role === 'assistant') return { role: 'assistant', text: m.imageUrl ? `[foto enviada: ${m.text}]` : m.text };
    return { role: 'assistant', text: `(mensagem automática) ${m.text}` };
  };

  return {
    simulated: true,
    async customer() {
      const s = await load();
      return { name: s.customerName, phone: s.phone, document: s.document, blingContactId: null };
    },
    async memory() {
      const s = await load();
      const all = simMessages(s.messages);
      const startRecent = Math.max(0, all.length - MEMORY_WINDOW);
      const pending = all.slice(s.summaryUpTo, startRecent);
      const items = (list: SimMessage[]) => list.map(toItem).filter((x): x is HistoryItem => x !== null);
      return {
        summary: s.summary,
        recent: items(all.slice(startRecent)),
        pendingOlder: items(pending),
        async commitSummary(summary) {
          await db.botSimSession.update({ where: { id: sessionId }, data: { summary, summaryUpTo: startRecent } });
        },
      };
    },
    sendText: (text) => push({ role: 'assistant', text }),
    sendImage: (url, caption) => push({ role: 'assistant', text: caption, imageUrl: url }),
    async handoff(reason) {
      await db.botSimSession.update({ where: { id: sessionId }, data: { handedOff: true, handoffReason: reason.slice(0, 300), failedAttempts: 0 } });
      await push({ role: 'system', text: `Conversa transferida para atendente humano: ${reason}` });
    },
    async failedAttempts() {
      return (await load()).failedAttempts;
    },
    async setFailedAttempts(n) {
      await db.botSimSession.update({ where: { id: sessionId }, data: { failedAttempts: n } });
    },
    async saveDocument(doc) {
      const s = await load();
      if (!s.document) await db.botSimSession.update({ where: { id: sessionId }, data: { document: doc } });
    },
    async log(data) {
      await db.botLog.create({ data: { ...data, simulated: true, simSessionId: sessionId } });
    },
  };
}
