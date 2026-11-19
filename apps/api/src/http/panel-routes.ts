import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRoutes, requireAuth } from '../auth/routes.js';
import type { Deps } from '../deps.js';
import {
  createNumber,
  importNumbersFromWaba,
  listNumbersWithStats,
  resumeCampaigns,
  sendTestMessage,
  syncNumber,
  updateNumber,
} from '../numbers/service.js';
import { getSetting, setSetting, SETTINGS } from '../settings.js';
import {
  buildTemplateComponents,
  createTemplate,
  createTemplateSchema,
  renderTemplate,
  syncTemplates,
  templateVariables,
} from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { blingPublicRoutes, blingRoutes } from './bling-routes.js';
import { botRoutes } from './bot-routes.js';
import { campaignRoutes } from './campaign-routes.js';
import { contactsRoutes } from './contacts-routes.js';
import { parse } from './errors.js';
import { inboxRoutes } from './inbox-routes.js';
import { chargeRoutes } from './charge-routes.js';
import { customerRoutes } from './customer-routes.js';
import { integrationRoutes } from './integration-routes.js';
import { relationRoutes } from './relation-routes.js';
import { siteRoutes } from './site-routes.js';
import { supplierRoutes } from './supplier-routes.js';
import { orderRoutes } from './order-routes.js';
import { teamRoutes } from './team-routes.js';

const role = z.enum(['ATTENDANCE', 'CAMPAIGNS', 'BOTH']);

const createNumberSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'o phone_number_id é só números (veja em WhatsApp > Configuração da API)'),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, 'o WABA ID é só números'),
  displayName: z.string().trim().max(80).optional(),
  accessToken: z.string().trim().min(20).optional().or(z.literal('').transform(() => undefined)),
  role: role.default('BOTH'),
  baseSendRatePerMinute: z.coerce.number().int().min(1).max(120).optional(),
});

const updateNumberSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  role: role.optional(),
  botEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  baseSendRatePerMinute: z.coerce.number().int().min(1).max(120).optional(),
  accessToken: z.string().trim().min(20).nullable().optional(),
});

/**
 * Para o painel e o Meta Webhook usarem a MESMA porta, os dados do painel ficam em /api/*.
 * O Next.js repassa /api/* para cá (mesma origem → cookie SameSite=Strict, sem CORS).
 */
export function panelRoutes(deps: Deps) {
  return async (app: FastifyInstance) => {
    await app.register(cookie);
    await authRoutes(app, deps);
    await blingPublicRoutes(app, deps);
    await siteRoutes(app, deps);

    // Daqui para baixo, tudo exige login.
    await app.register(async (priv) => {
      priv.addHook('preHandler', requireAuth(deps));
      priv.addHook('onRequest', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });
      await contactsRoutes(priv, deps);
      await inboxRoutes(priv, deps);
      await blingRoutes(priv, deps);
      await botRoutes(priv, deps);
      await campaignRoutes(priv, deps);
      await teamRoutes(priv, deps);
      await orderRoutes(priv, deps);
      await chargeRoutes(priv, deps);
      await customerRoutes(priv, deps);
      await relationRoutes(priv, deps);
      await supplierRoutes(priv, deps);
      await integrationRoutes(priv, deps);

      // ── Visão geral ──
      priv.get('/dashboard', async () => {
        const [numbers, alerts, contacts, optOuts, conversations, templates] = await Promise.all([
          listNumbersWithStats(deps),
          deps.db.alert.findMany({ where: { readAt: null }, orderBy: { createdAt: 'desc' }, take: 20 }),
          deps.db.contact.count(),
          deps.db.contact.count({ where: { optOut: true } }),
          deps.db.conversation.count({ where: { awaitingReply: true } }),
          deps.db.template.groupBy({ by: ['status'], _count: { _all: true } }),
        ]);
        return {
          numbers,
          alerts,
          totals: {
            contacts,
            optOuts,
            awaitingReply: conversations,
            templates: Object.fromEntries(templates.map((t) => [t.status, t._count._all])),
          },
          bot: { enabled: await getSetting(deps.db, SETTINGS.botEnabled, true), mode: deps.env.BOT_MODE },
        };
      });

      priv.post('/alerts/:id/read', async (req) => {
        const { id } = req.params as { id: string };
        await deps.db.alert.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
        return { ok: true };
      });
      priv.post('/alerts/read-all', async () => {
        const r = await deps.db.alert.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
        return { updated: r.count };
      });

      // ── Bot (chave global) ──
      priv.put('/settings/bot', async (req) => {
        const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
        await setSetting(deps.db, SETTINGS.botEnabled, enabled);
        return { enabled };
      });

      // ── Números ──
      priv.get('/numbers', async () => ({ numbers: await listNumbersWithStats(deps) }));
      priv.post('/numbers', async (req, reply) => {
        const created = await createNumber(deps, parse(createNumberSchema, req.body));
        return reply.code(201).send({ number: created });
      });
      priv.post('/numbers/import', async (req) => {
        const { wabaId } = parse(z.object({ wabaId: z.string().trim().optional() }), req.body ?? {});
        return importNumbersFromWaba(deps, wabaId || deps.env.META_WABA_ID);
      });
      priv.patch('/numbers/:id', async (req) => {
        const { id } = req.params as { id: string };
        return { number: await updateNumber(deps, id, parse(updateNumberSchema, req.body)) };
      });
      priv.post('/numbers/:id/sync', async (req) => {
        const { id } = req.params as { id: string };
        return { number: await syncNumber(deps, id) };
      });
      priv.post('/numbers/:id/resume-campaigns', async (req) => {
        const { id } = req.params as { id: string };
        return { number: await resumeCampaigns(deps, id) };
      });
      priv.post('/numbers/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
        const { id } = req.params as { id: string };
        const { to } = parse(z.object({ to: z.string().trim().min(8, 'informe o telefone') }), req.body);
        return sendTestMessage(deps, id, to);
      });

      // ── Templates ──
      priv.get('/templates', async (req) => {
        const { status } = req.query as { status?: string };
        const templates = await deps.db.template.findMany({
          where: status ? { status } : { status: { not: 'DELETED' } },
          orderBy: [{ status: 'asc' }, { name: 'asc' }],
        });
        return {
          templates: templates.map((t) => {
            const comps = t.components as unknown as TemplateComponentDef[];
            const body = comps.find((c) => c.type === 'BODY');
            const header = comps.find((c) => c.type === 'HEADER');
            return {
              ...t,
              variables: { header: templateVariables(header?.text).length, body: templateVariables(body?.text).length },
              preview: renderTemplate(comps, {
                header: header?.example?.header_text,
                body: body?.example?.body_text?.[0],
              }),
            };
          }),
        };
      });
      priv.post('/templates/sync', async () => syncTemplates(deps));
      priv.post('/templates', async (req, reply) => {
        const created = await createTemplate(deps, parse(createTemplateSchema, req.body));
        return reply.code(201).send({ template: created });
      });
      priv.post('/templates/preview', async (req) => {
        const body = parse(createTemplateSchema.partial({ name: true }).extend({ name: z.string().default('preview') }), req.body);
        const components = buildTemplateComponents(body);
        return {
          components,
          preview: renderTemplate(components, { header: body.headerExample ? [body.headerExample] : [], body: body.bodyExamples }),
        };
      });
    });
  };
}
