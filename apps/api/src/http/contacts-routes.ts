import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteContactData,
  exportContactData,
  getContactDetail,
  importContacts,
  listContacts,
  recordConsent,
  setContactTags,
} from '../contacts/service.js';
import { segmentSchema, segmentWhere } from '../contacts/segment.js';
import type { Deps } from '../deps.js';
import { normalizePhone } from '../lib/phone.js';
import { badRequest, HttpError, notFound, parse } from './errors.js';

const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (Array.isArray(v) ? v : v ? v.split(',').filter(Boolean) : []));

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  tags: csvList,
  consent: z.enum(['any', 'optIn', 'optOut', 'noConsent']).default('any'),
  inactiveDays: z.coerce.number().int().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function uniqueViolation(err: unknown, msg: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(409, msg);
  throw err;
}

export async function contactsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // ── Contatos ──
  app.get('/contacts', async (req) => {
    const q = parse(listQuery, req.query);
    return listContacts(deps, segmentSchema.parse({ search: q.search, tagsAny: q.tags, consent: q.consent, inactiveDays: q.inactiveDays }), q.page, q.pageSize);
  });

  app.post('/contacts', async (req, reply) => {
    const body = parse(
      z.object({
        phone: z.string().min(8),
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
        tagIds: z.array(z.string()).default([]),
        optInSource: z.string().trim().max(100).optional(),
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('Telefone inválido. Use DDD + número.');
    const contact = await deps.db.contact
      .create({ data: { phone, name: body.name || null, email: body.email ?? null } })
      .catch((e) => uniqueViolation(e, 'Já existe um contato com este telefone.'));
    if (body.tagIds.length) await setContactTags(deps, contact.id, body.tagIds);
    if (body.optInSource) await recordConsent(deps, contact.id, 'OPT_IN', body.optInSource, 'cadastro manual');
    return reply.code(201).send({ contact });
  });

  app.get('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { contact: await getContactDetail(deps, id) };
  });

  app.patch('/contacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        name: z.string().trim().max(120).nullable().optional(),
        email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
        document: z.string().trim().max(20).nullable().optional(),
        tagIds: z.array(z.string()).optional(),
      }),
      req.body,
    );
    const exists = await deps.db.contact.findUnique({ where: { id } });
    if (!exists) throw notFound('Contato não encontrado');
    await deps.db.contact.update({
      where: { id },
      data: { name: body.name, email: body.email, document: body.document?.replace(/\D/g, '') || body.document },
    });
    if (body.tagIds) await setContactTags(deps, id, body.tagIds);
    return { contact: await getContactDetail(deps, id) };
  });

  app.post('/contacts/:id/consent', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        action: z.enum(['OPT_IN', 'OPT_OUT']),
        source: z.string().trim().min(3, 'informe a origem (ex.: "pediu no balcão")').max(100),
        detail: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    await recordConsent(deps, id, body.action, body.source, body.detail);
    return { contact: await getContactDetail(deps, id) };
  });

  app.get('/contacts/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await exportContactData(deps, id);
    const name = `dados-contato-${data.contato.telefone.replace(/\D/g, '')}.json`;
    return reply.header('Content-Disposition', `attachment; filename="${name}"`).type('application/json').send(JSON.stringify(data, null, 2));
  });

  app.post('/contacts/:id/delete', async (req) => {
    const { id } = req.params as { id: string };
    const { confirmPhone } = parse(z.object({ confirmPhone: z.string().min(8) }), req.body);
    await deleteContactData(deps, id, confirmPhone);
    return { ok: true };
  });

  app.post('/contacts/import', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const body = parse(
      z.object({
        csv: z.string().min(1, 'arquivo vazio').max(5 * 1024 * 1024, 'arquivo acima de 5 MB'),
        defaultTags: z.array(z.string().trim().max(50)).default([]),
        optInSource: z.string().trim().max(100).optional(),
        allOptIn: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
      req.body,
    );
    return importContacts(deps, body);
  });

  /** Quantos contatos um segmento alcança (e quantos podem receber marketing). */
  app.post('/segments/count', async (req) => {
    const s = parse(segmentSchema, req.body ?? {});
    const where = segmentWhere(s);
    const [total, reachable] = await Promise.all([
      deps.db.contact.count({ where }),
      deps.db.contact.count({ where: { AND: [where, { optIn: true, optOut: false }] } }),
    ]);
    return { total, reachable };
  });

  // ── Tags ──
  app.get('/tags', async () => {
    const tags = await deps.db.tag.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { contacts: true } } } });
    return { tags: tags.map(({ _count, ...t }) => ({ ...t, contacts: _count.contacts })) };
  });
  const tagBody = z.object({ name: z.string().trim().min(1).max(50), color: z.string().max(20).nullable().optional() });
  app.post('/tags', async (req, reply) => {
    const body = parse(tagBody, req.body);
    const tag = await deps.db.tag.create({ data: body }).catch((e) => uniqueViolation(e, 'Já existe uma tag com esse nome.'));
    return reply.code(201).send({ tag });
  });
  app.patch('/tags/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(tagBody.partial(), req.body);
    const tag = await deps.db.tag.update({ where: { id }, data: body }).catch((e) => uniqueViolation(e, 'Já existe uma tag com esse nome.'));
    return { tag };
  });
  app.delete('/tags/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deps.db.tag.deleteMany({ where: { id } });
    return { ok: true };
  });

  // ── Respostas rápidas ──
  app.get('/quick-replies', async () => ({ quickReplies: await deps.db.quickReply.findMany({ orderBy: { shortcut: 'asc' } }) }));
  const qrBody = z.object({
    shortcut: z
      .string()
      .trim()
      .min(2)
      .max(30)
      .transform((s) => (s.startsWith('/') ? s : `/${s}`).toLowerCase())
      .refine((s) => /^\/[a-z0-9_-]+$/.test(s), 'atalho: use letras, números, - ou _ (ex.: /pix)'),
    title: z.string().trim().min(1).max(60),
    body: z.string().trim().min(1).max(4096),
  });
  app.post('/quick-replies', async (req, reply) => {
    const qr = await deps.db.quickReply.create({ data: parse(qrBody, req.body) }).catch((e) => uniqueViolation(e, 'Já existe uma resposta com esse atalho.'));
    return reply.code(201).send({ quickReply: qr });
  });
  app.patch('/quick-replies/:id', async (req) => {
    const { id } = req.params as { id: string };
    const qr = await deps.db.quickReply
      .update({ where: { id }, data: parse(qrBody.partial(), req.body) })
      .catch((e) => uniqueViolation(e, 'Já existe uma resposta com esse atalho.'));
    return { quickReply: qr };
  });
  app.delete('/quick-replies/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deps.db.quickReply.deleteMany({ where: { id } });
    return { ok: true };
  });
}
