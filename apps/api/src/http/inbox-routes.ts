import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import {
  assignConversation,
  assumeConversation,
  type Agent,
  fetchMessageMedia,
  getConversation,
  listConversations,
  listMessages,
  markRead,
  releaseConversation,
  sendHumanMedia,
  sendHumanText,
  sendTemplateInConversation,
  startConversation,
} from '../inbox/service.js';
import { badRequest, parse } from './errors.js';

const agent = (req: FastifyRequest): Agent => ({ id: req.user!.id, name: req.user!.name || req.user!.email.split('@')[0]! });

const templateParams = {
  templateId: z.string().min(1, 'escolha o template'),
  header: z.array(z.string()).optional(),
  body: z.array(z.string()).optional(),
};

export async function inboxRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 5 } });

  app.get('/conversations', async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(['all', 'awaiting', 'bot', 'human', 'unread', 'mine']).default('all'),
        search: z.string().trim().max(100).optional(),
        numberId: z.string().optional(),
        cursor: z.string().optional(),
        take: z.coerce.number().int().min(1).max(100).default(40),
      }),
      req.query,
    );
    return listConversations(deps, q, req.user!.id);
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { conversation: await getConversation(deps, id) };
  });

  app.get('/conversations/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    const { before } = parse(z.object({ before: z.string().datetime().optional() }), req.query);
    return listMessages(deps, id, before);
  });

  app.post('/conversations/:id/read', async (req) => {
    const { id } = req.params as { id: string };
    await markRead(deps, id);
    return { ok: true };
  });

  app.post('/conversations/:id/assume', async (req) => {
    const { id } = req.params as { id: string };
    return { conversation: await assumeConversation(deps, id, agent(req)) };
  });

  app.post('/conversations/:id/assign', async (req) => {
    const { id } = req.params as { id: string };
    const { userId } = parse(z.object({ userId: z.string().min(1).nullable() }), req.body);
    return { conversation: await assignConversation(deps, id, userId) };
  });

  app.post('/conversations/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    return { conversation: await releaseConversation(deps, id) };
  });

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = parse(z.object({ text: z.string().trim().min(1, 'mensagem vazia').max(4096) }), req.body);
    return reply.code(201).send({ message: await sendHumanText(deps, id, text, agent(req)) });
  });

  app.post('/conversations/:id/template', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object(templateParams), req.body);
    return reply.code(201).send({ message: await sendTemplateInConversation(deps, id, body, 'HUMAN', agent(req)) });
  });

  app.post('/conversations/:id/media', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await req.file();
    if (!file) throw badRequest('Envie um arquivo.');
    const data = await file.toBuffer().catch(() => {
      throw badRequest('Arquivo acima de 16 MB.');
    });
    const captionField = file.fields.caption as { value?: unknown } | undefined;
    const caption = typeof captionField?.value === 'string' ? captionField.value.slice(0, 1024) : undefined;
    const msg = await sendHumanMedia(deps, id, { data, mimeType: file.mimetype, filename: file.filename || 'arquivo' }, caption, agent(req));
    return reply.code(201).send({ message: msg });
  });

  app.post('/contacts/:id/start-conversation', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ numberId: z.string().min(1, 'escolha o número'), ...templateParams }), req.body);
    return reply.code(201).send(await startConversation(deps, { contactId: id, ...body }, agent(req)));
  });

  /** Mídia de uma mensagem (proxy autenticado — o link da Meta exige token e expira). */
  app.get('/media/:messageId', async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const media = await fetchMessageMedia(deps, messageId);
    return reply.header('Cache-Control', 'private, max-age=3600').type(media.mimeType).send(media.data);
  });
}
