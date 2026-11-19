import type { Prisma } from '@prisma/client';
import type { Deps } from '../deps.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { childLogger } from '../lib/logger.js';
import { sendMediaMessage, sendTemplateMessage, sendTextMessage } from '../messaging/outbound.js';
import { isServiceWindowOpen, serviceWindowClosesAt, ServiceWindowClosedError } from '../messaging/window.js';
import { buildSendComponents, renderTemplate, sanitizeParam } from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { WhatsAppApiError, type MediaKind } from '../whatsapp/provider.js';

const log = childLogger('inbox');

export type InboxFilter = 'all' | 'awaiting' | 'bot' | 'human' | 'unread' | 'mine';

/** Quem da equipe está agindo (para registrar o responsável e o autor das mensagens). */
export type Agent = { id: string; name: string };

const assignedToSelect = { select: { id: true, name: true, email: true } } as const;
const agentName = (u: { name: string; email: string } | null) => (u ? u.name || u.email.split('@')[0]! : null);

export async function listConversations(
  deps: Deps,
  q: { filter: InboxFilter; search?: string; numberId?: string; take: number; cursor?: string },
  me?: string,
) {
  const where: Prisma.ConversationWhereInput = {
    lastMessageAt: { not: null },
    ...(q.numberId ? { phoneNumberId: q.numberId } : {}),
    ...(q.filter === 'awaiting' ? { awaitingReply: true } : {}),
    ...(q.filter === 'bot' ? { handler: 'BOT' } : {}),
    ...(q.filter === 'human' ? { handler: 'HUMAN' } : {}),
    ...(q.filter === 'unread' ? { unreadCount: { gt: 0 } } : {}),
    ...(q.filter === 'mine' ? { assignedToId: me ?? '-' } : {}),
  };
  if (q.search) {
    const digits = q.search.replace(/\D/g, '');
    where.contact = {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
      ],
    };
  }
  const rows = await deps.db.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: q.take + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: {
      contact: { select: { id: true, name: true, phone: true, optOut: true } },
      phoneNumber: { select: { id: true, displayName: true } },
      assignedTo: assignedToSelect,
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, type: true, direction: true, sentBy: true, status: true, createdAt: true } },
    },
  });
  const hasMore = rows.length > q.take;
  const page = rows.slice(0, q.take);
  const counts = await deps.db.conversation.groupBy({
    by: ['handler'],
    where: { lastMessageAt: { not: null }, ...(q.numberId ? { phoneNumberId: q.numberId } : {}) },
    _count: { _all: true },
  });
  const [awaiting, unread, mine] = await Promise.all([
    deps.db.conversation.count({ where: { awaitingReply: true, ...(q.numberId ? { phoneNumberId: q.numberId } : {}) } }),
    deps.db.conversation.count({ where: { unreadCount: { gt: 0 }, ...(q.numberId ? { phoneNumberId: q.numberId } : {}) } }),
    me
      ? deps.db.conversation.count({ where: { lastMessageAt: { not: null }, assignedToId: me, ...(q.numberId ? { phoneNumberId: q.numberId } : {}) } })
      : 0,
  ]);
  return {
    conversations: page.map(({ messages, assignedTo, ...c }) => ({
      ...c,
      assignedTo: assignedTo ? { id: assignedTo.id, name: agentName(assignedTo)! } : null,
      lastMessage: messages[0] ?? null,
      windowOpen: isServiceWindowOpen(c.lastInboundAt),
    })),
    nextCursor: hasMore ? page[page.length - 1]?.id : null,
    counts: {
      bot: counts.find((c) => c.handler === 'BOT')?._count._all ?? 0,
      human: counts.find((c) => c.handler === 'HUMAN')?._count._all ?? 0,
      awaiting,
      unread,
      mine,
    },
  };
}

export async function getConversation(deps: Deps, id: string) {
  const c = await deps.db.conversation.findUnique({
    where: { id },
    include: {
      contact: { include: { tags: { include: { tag: true } } } },
      phoneNumber: { select: { id: true, displayName: true, displayPhone: true, wabaId: true, botEnabled: true } },
      assignedTo: assignedToSelect,
    },
  });
  if (!c) throw notFound('Conversa não encontrada');
  const { contact, assignedTo, ...rest } = c;
  return {
    ...rest,
    assignedTo: assignedTo ? { id: assignedTo.id, name: agentName(assignedTo)! } : null,
    contact: { ...contact, tags: contact.tags.map((t) => t.tag) },
    windowOpen: isServiceWindowOpen(c.lastInboundAt),
    windowClosesAt: serviceWindowClosesAt(c.lastInboundAt),
  };
}

export async function listMessages(deps: Deps, conversationId: string, before?: string, take = 50) {
  const rows = await deps.db.message.findMany({
    where: { conversationId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    select: {
      id: true,
      direction: true,
      type: true,
      body: true,
      mediaId: true,
      mediaMime: true,
      mediaUrl: true,
      templateName: true,
      status: true,
      errorMessage: true,
      sentBy: true,
      sentByUser: { select: { name: true, email: true } },
      createdAt: true,
      payload: true,
    },
  });
  const hasMore = rows.length > take;
  return {
    messages: rows
      .slice(0, take)
      .reverse()
      .map(({ payload, sentByUser, ...m }) => ({
        ...m,
        sentByName: agentName(sentByUser),
        filename: m.type === 'document' ? ((payload as { document?: { filename?: string } } | null)?.document?.filename ?? null) : null,
      })),
    hasMore,
  };
}

export async function markRead(deps: Deps, id: string) {
  await deps.db.conversation.updateMany({ where: { id }, data: { unreadCount: 0 } });
}

/**
 * Humano assume: o bot para de responder neste contato. Se ninguém da equipe está com a
 * conversa, quem assumiu vira o responsável (não tira de quem já está atendendo).
 */
export async function assumeConversation(deps: Deps, id: string, who?: Agent) {
  const c = await deps.db.conversation.findUnique({ where: { id } });
  if (!c) throw notFound('Conversa não encontrada');
  const takeOwner = Boolean(who && !c.assignedToId);
  if (c.handler === 'HUMAN' && !takeOwner) return c;
  if (c.handler !== 'HUMAN') log.info({ conversationId: id, who: who?.name }, 'Conversa assumida por humano');
  return deps.db.conversation.update({
    where: { id },
    data: {
      ...(c.handler !== 'HUMAN' ? { handler: 'HUMAN' as const, handoffAt: new Date(), handoffReason: `Assumida por ${who?.name ?? 'atendente'}` } : {}),
      ...(takeOwner && who ? { assignedToId: who.id } : {}),
    },
  });
}

/** Passa a conversa para alguém da equipe (ou tira o responsável, com null). */
export async function assignConversation(deps: Deps, id: string, userId: string | null) {
  const c = await deps.db.conversation.findUnique({ where: { id } });
  if (!c) throw notFound('Conversa não encontrada');
  if (userId) {
    const u = await deps.db.user.findUnique({ where: { id: userId } });
    if (!u || !u.active) throw badRequest('Essa pessoa não está ativa na equipe.');
  }
  await deps.db.conversation.update({ where: { id }, data: { assignedToId: userId } });
  return getConversation(deps, id);
}

async function stampAuthor(deps: Deps, messageId: string | undefined, who?: Agent) {
  if (messageId && who) await deps.db.message.update({ where: { id: messageId }, data: { sentByUserId: who.id } });
}

/** Devolve ao bot (zera as tentativas sem sucesso). */
export async function releaseConversation(deps: Deps, id: string) {
  const c = await deps.db.conversation.findUnique({ where: { id } });
  if (!c) throw notFound('Conversa não encontrada');
  return deps.db.conversation.update({
    where: { id },
    data: { handler: 'BOT', handoffAt: null, handoffReason: null, botFailedAttempts: 0 },
  });
}

function mapSendError(err: unknown): never {
  if (err instanceof ServiceWindowClosedError) throw new HttpError(409, err.message);
  if (err instanceof WhatsAppApiError) throw badRequest(`A Meta recusou o envio: ${err.message}`);
  throw err;
}

/** Atendente escreve: se o bot estava com a conversa, o humano assume automaticamente. */
export async function sendHumanText(deps: Deps, id: string, text: string, who?: Agent) {
  await assumeConversation(deps, id, who);
  try {
    const msg = await sendTextMessage(deps, { conversationId: id, body: text, sentBy: 'HUMAN' });
    await stampAuthor(deps, msg.id, who);
    await markRead(deps, id);
    return msg;
  } catch (err) {
    mapSendError(err);
  }
}

const MEDIA_LIMITS: Record<'image' | 'document' | 'video' | 'audio', number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
};

export function mediaKindFor(mime: string): Extract<MediaKind, 'image' | 'document' | 'video' | 'audio'> {
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image'; // WhatsApp só aceita JPEG/PNG como imagem
  if (/^video\/(mp4|3gpp)$/.test(mime)) return 'video';
  if (/^audio\/(aac|mp4|mpeg|amr|ogg)/.test(mime)) return 'audio';
  return 'document';
}

export async function sendHumanMedia(
  deps: Deps,
  id: string,
  file: { data: Buffer; mimeType: string; filename: string },
  caption: string | undefined,
  who?: Agent,
) {
  const kind = mediaKindFor(file.mimeType);
  if (file.data.length > MEDIA_LIMITS[kind]) {
    throw badRequest(`Arquivo grande demais para ${kind === 'image' ? 'imagem' : 'esse tipo'} (máx. ${MEDIA_LIMITS[kind] / 1024 / 1024} MB).`);
  }
  const conv = await deps.db.conversation.findUnique({ where: { id }, include: { phoneNumber: true } });
  if (!conv) throw notFound('Conversa não encontrada');
  if (!isServiceWindowOpen(conv.lastInboundAt)) mapSendError(new ServiceWindowClosedError(conv.lastInboundAt));
  await assumeConversation(deps, id, who);
  try {
    const mediaId = await deps.providers(conv.phoneNumber).uploadMedia(file.data, file.mimeType, file.filename);
    const msg = await sendMediaMessage(deps, {
      conversationId: id,
      sentBy: 'HUMAN',
      kind,
      mediaId,
      caption: kind === 'audio' ? undefined : caption || undefined,
      filename: kind === 'document' ? file.filename : undefined,
    });
    await deps.db.message.update({
      where: { id: msg.id },
      data: {
        mediaMime: file.mimeType,
        sentByUserId: who?.id,
        payload: kind === 'document' ? { document: { filename: file.filename } } : undefined,
      },
    });
    return msg;
  } catch (err) {
    mapSendError(err);
  }
}

/**
 * Envia um template aprovado numa conversa (única opção fora da janela de 24h).
 * Regras: nunca para quem pediu para sair; MARKETING só para quem deu opt-in.
 */
export async function sendTemplateInConversation(
  deps: Deps,
  conversationId: string,
  input: { templateId: string; header?: string[]; body?: string[]; headerDocument?: { id?: string; link?: string; filename: string }; headerImage?: { link?: string; id?: string } },
  sentBy: 'HUMAN' | 'BOT' | 'CAMPAIGN' | 'SYSTEM' = 'HUMAN',
  who?: Agent,
) {
  const conv = await deps.db.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, phoneNumber: true } });
  if (!conv) throw notFound('Conversa não encontrada');
  const tpl = await deps.db.template.findUnique({ where: { id: input.templateId } });
  if (!tpl) throw notFound('Template não encontrado');
  if (tpl.status !== 'APPROVED') throw badRequest('Só é possível enviar templates aprovados pela Meta.');
  if (tpl.wabaId !== conv.phoneNumber.wabaId) throw badRequest('Este template pertence a outra conta (WABA) e não pode ser usado por este número.');
  if (conv.contact.optOut && tpl.category === 'MARKETING') {
    throw new HttpError(409, 'Este contato pediu para não receber mensagens de marketing (opt-out).');
  }
  if (tpl.category === 'MARKETING' && !conv.contact.optIn) {
    throw new HttpError(409, 'Template de marketing exige opt-in do contato. Registre o consentimento antes (na ficha do contato).');
  }
  const defs = tpl.components as unknown as TemplateComponentDef[];
  const components = buildSendComponents(defs, input);
  // template com PDF no cabeçalho (pedido de compra, cotação): o arquivo já foi enviado para a Meta
  if (defs.some((c) => c.type === 'HEADER' && c.format === 'DOCUMENT')) {
    if (!input.headerDocument) throw badRequest('Este template precisa de um PDF no cabeçalho.');
    components.unshift({ type: 'header', parameters: [{ type: 'document', document: { ...input.headerDocument } }] });
  }
  if (defs.some((c) => c.type === 'HEADER' && c.format === 'IMAGE')) {
    if (!input.headerImage) throw badRequest('Este template precisa de uma imagem no cabeçalho.');
    components.unshift({ type: 'header', parameters: [{ type: 'image', image: { ...input.headerImage } as { link: string } }] });
  }
  try {
    const msg = await sendTemplateMessage(deps, {
      conversationId,
      sentBy,
      name: tpl.name,
      language: tpl.language,
      components,
      // histórico com os mesmos valores (já limpos) que a Meta recebeu
      renderedBody: renderTemplate(defs, { header: input.header?.map(sanitizeParam), body: input.body?.map(sanitizeParam) }),
    });
    if (sentBy === 'HUMAN') {
      await stampAuthor(deps, msg.id, who);
      await assumeConversation(deps, conversationId, who);
    }
    return msg;
  } catch (err) {
    mapSendError(err);
  }
}

/** Iniciar conversa com um contato (sempre por template). */
export async function startConversation(
  deps: Deps,
  input: { contactId: string; numberId: string; templateId: string; header?: string[]; body?: string[] },
  who?: Agent,
) {
  const [contact, number] = await Promise.all([
    deps.db.contact.findUnique({ where: { id: input.contactId } }),
    deps.db.phoneNumber.findUnique({ where: { id: input.numberId } }),
  ]);
  if (!contact) throw notFound('Contato não encontrado');
  if (!number || !number.isActive) throw notFound('Número não encontrado ou desativado');
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: number.id } },
    create: { contactId: contact.id, phoneNumberId: number.id },
    update: {},
  });
  await sendTemplateInConversation(deps, conv.id, input, 'HUMAN', who);
  return { conversationId: conv.id };
}

/** Baixa a mídia de uma mensagem (para exibir no painel). */
export async function fetchMessageMedia(deps: Deps, messageId: string) {
  const msg = await deps.db.message.findUnique({ where: { id: messageId }, include: { phoneNumber: true } });
  if (!msg?.mediaId) throw notFound('Mensagem sem mídia');
  try {
    return await deps.providers(msg.phoneNumber).downloadMedia(msg.mediaId);
  } catch (err) {
    if (err instanceof WhatsAppApiError) throw new HttpError(502, `Não foi possível baixar a mídia: ${err.message}`);
    throw err;
  }
}
