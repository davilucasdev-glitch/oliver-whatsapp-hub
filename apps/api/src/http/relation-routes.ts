import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Agent } from '../inbox/service.js';
import { buildRelationLists, getRelationConfig, getRelationSync, RELATION_INFO, RELATION_KINDS, saveRelationConfig, sendRelation, syncRelationData } from '../relation/service.js';
import { createTemplate } from '../templates/service.js';
import { badRequest, HttpError, parse } from './errors.js';

const agent = (req: FastifyRequest): Agent => ({ id: req.user!.id, name: req.user!.name || req.user!.email.split('@')[0]! });
const requireAdmin = (req: FastifyRequest) => {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador muda essas configurações.');
};
const link = z.string().trim().max(300).refine((u) => !u || /^https?:\/\/\S+$/.test(u), 'link inválido (comece com https://)');

export async function relationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/relation', async () => {
    const [lists, config, sync, templates, numbers] = await Promise.all([
      buildRelationLists(deps),
      getRelationConfig(deps.db),
      getRelationSync(deps.db),
      deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, select: { name: true, status: true, rejectedReason: true } }),
      deps.db.phoneNumber.findMany({ where: { isActive: true }, select: { id: true, displayName: true, displayPhone: true } }),
    ]);
    return {
      ...lists,
      config,
      sync,
      numbers,
      kinds: RELATION_KINDS.map((k) => ({ key: k, ...RELATION_INFO[k], template: templates.find((t) => t.name === config.templates[k]) ?? null })),
    };
  });

  app.put('/relation/config', async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        reviewLink: link,
        birthdayGift: z.string().trim().max(200),
        restockDays: z.number().int().min(7).max(365),
        restockLink: link,
        phoneNumberId: z.string().nullable(),
        templates: z.object(Object.fromEntries(RELATION_KINDS.map((k) => [k, z.string().trim().regex(/^[a-z0-9_]+$/)])) as Record<(typeof RELATION_KINDS)[number], z.ZodString>),
      }),
      req.body,
    );
    await saveRelationConfig(deps.db, body);
    return { config: await getRelationConfig(deps.db) };
  });

  /** Templates de marketing (com o botão "Parar promoções", boa prática para não perder o número). */
  app.post('/relation/templates', async (req) => {
    requireAdmin(req);
    const cfg = await getRelationConfig(deps.db);
    const results = [];
    for (const k of RELATION_KINDS) {
      const s = RELATION_INFO[k].suggested;
      const name = cfg.templates[k];
      const existing = await deps.db.template.findFirst({ where: { name, status: { not: 'DELETED' } } });
      if (existing) {
        results.push({ kind: k, name, status: existing.status });
        continue;
      }
      try {
        const row = await createTemplate(deps, { name, language: 'pt_BR', category: 'MARKETING', body: s.body, bodyExamples: s.examples, footer: 'Oliver Cosméticos', quickReplies: [], addOptOutButton: true });
        results.push({ kind: k, name, status: row.status });
      } catch (err) {
        results.push({ kind: k, name, status: 'ERRO', error: (err as Error).message });
      }
    }
    return { results };
  });

  app.post('/relation/sync', async () => {
    if (!(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }))) throw badRequest('O Bling não está conectado.');
    try {
      return await syncRelationData(deps);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  app.post('/relation/send', async (req) => {
    const { key } = parse(z.object({ key: z.string().min(3).max(300) }), req.body);
    return sendRelation(deps, agent(req), key);
  });

  app.post('/relation/send-many', async (req) => {
    const { keys } = parse(z.object({ keys: z.array(z.string().min(3).max(300)).min(1).max(300) }), req.body);
    const lists = await buildRelationLists(deps);
    const results = [];
    for (const key of keys) {
      try {
        results.push(await sendRelation(deps, agent(req), key, lists));
      } catch (err) {
        results.push({ key, status: 'FAILED' as const, reason: (err as Error).message });
      }
    }
    return { results, sent: results.filter((r) => r.status === 'SENT').length };
  });

  app.get('/relation/history', async () => {
    const rows = await deps.db.relationNotice.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const contacts = new Map((await deps.db.contact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
    const users = new Map((await deps.db.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email.split('@')[0]!]));
    return {
      history: rows.map((r) => ({ ...r, contactName: contacts.get(r.contactId)?.name ?? contacts.get(r.contactId)?.phone ?? null, sentBy: r.sentByUserId ? (users.get(r.sentByUserId) ?? null) : null })),
    };
  });
}
