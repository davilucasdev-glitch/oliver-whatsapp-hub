import type { Message, Prisma, SenderKind } from '@prisma/client';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import type { MediaKind, SendResult, TemplateComponent, WhatsAppProvider } from '../whatsapp/provider.js';
import { WhatsAppApiError } from '../whatsapp/provider.js';
import { isServiceWindowOpen, ServiceWindowClosedError } from './window.js';

const log = childLogger('outbound');

interface BaseSend {
  conversationId: string;
  sentBy: SenderKind;
  campaignId?: string;
}

export interface SendTextParams extends BaseSend {
  body: string;
  replyToWaMessageId?: string;
}

export interface SendTemplateParams extends BaseSend {
  name: string;
  language: string;
  components?: TemplateComponent[];
  /** Texto renderizado (para o histórico/painel). */
  renderedBody?: string;
}

export interface SendMediaParams extends BaseSend {
  kind: MediaKind;
  link?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

async function loadConversation(deps: Deps, conversationId: string) {
  const conv = await deps.db.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, phoneNumber: true },
  });
  if (!conv) throw new Error(`Conversa ${conversationId} não encontrada`);
  if (!conv.phoneNumber.isActive) throw new Error(`Número ${conv.phoneNumber.displayName} está desativado`);
  return conv;
}

/**
 * Cria a mensagem como QUEUED, chama o provedor e grava o wamid.
 * Os status seguintes (sent/delivered/read/failed) chegam pelo webhook.
 */
async function dispatch(
  deps: Deps,
  conv: Awaited<ReturnType<typeof loadConversation>>,
  data: Omit<Prisma.MessageUncheckedCreateInput, 'conversationId' | 'phoneNumberId' | 'direction' | 'status'>,
  call: (p: WhatsAppProvider) => Promise<SendResult>,
): Promise<Message> {
  const msg = await deps.db.message.create({
    data: {
      ...data,
      conversationId: conv.id,
      phoneNumberId: conv.phoneNumberId,
      direction: 'OUTBOUND',
      status: 'QUEUED',
    },
  });
  try {
    const provider = deps.providers(conv.phoneNumber);
    const res = await call(provider);
    const now = new Date();
    const [updated] = await deps.db.$transaction([
      deps.db.message.update({ where: { id: msg.id }, data: { waMessageId: res.messageId } }),
      deps.db.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, awaitingReply: false },
      }),
    ]);
    log.info({ conversationId: conv.id, type: data.type, wamid: res.messageId, sentBy: data.sentBy }, 'Mensagem enviada');
    return updated;
  } catch (err) {
    const e = err as Error;
    await deps.db.message.update({
      where: { id: msg.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorCode: err instanceof WhatsAppApiError ? String(err.code ?? err.status) : 'LOCAL',
        errorMessage: e.message.slice(0, 500),
      },
    });
    log.error({ conversationId: conv.id, err: e.message }, 'Falha ao enviar mensagem');
    throw err;
  }
}

export async function sendTextMessage(deps: Deps, p: SendTextParams): Promise<Message> {
  const body = p.body.trim();
  if (!body) throw new Error('Mensagem vazia');
  if (body.length > 4096) throw new Error('Mensagem acima de 4096 caracteres');
  const conv = await loadConversation(deps, p.conversationId);
  if (!isServiceWindowOpen(conv.lastInboundAt)) throw new ServiceWindowClosedError(conv.lastInboundAt);
  return dispatch(deps, conv, { type: 'text', body, sentBy: p.sentBy, campaignId: p.campaignId }, (prov) =>
    prov.sendText(conv.contact.phone, body, { replyTo: p.replyToWaMessageId }),
  );
}

export async function sendMediaMessage(deps: Deps, p: SendMediaParams): Promise<Message> {
  const conv = await loadConversation(deps, p.conversationId);
  if (!isServiceWindowOpen(conv.lastInboundAt)) throw new ServiceWindowClosedError(conv.lastInboundAt);
  return dispatch(
    deps,
    conv,
    { type: p.kind, body: p.caption ?? null, mediaId: p.mediaId, mediaUrl: p.link, sentBy: p.sentBy },
    (prov) =>
      prov.sendMedia({
        to: conv.contact.phone,
        kind: p.kind,
        link: p.link,
        mediaId: p.mediaId,
        caption: p.caption,
        filename: p.filename,
      }),
  );
}

/** Template aprovado: único tipo permitido fora da janela de 24h. */
export async function sendTemplateMessage(deps: Deps, p: SendTemplateParams): Promise<Message> {
  const conv = await loadConversation(deps, p.conversationId);
  return dispatch(
    deps,
    conv,
    {
      type: 'template',
      templateName: p.name,
      body: p.renderedBody ?? null,
      payload: { language: p.language, components: (p.components ?? []) as unknown as Prisma.InputJsonValue },
      sentBy: p.sentBy,
      campaignId: p.campaignId,
    },
    (prov) => prov.sendTemplate({ to: conv.contact.phone, name: p.name, language: p.language, components: p.components }),
  );
}
