import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { managementClient } from '../numbers/service.js';
import { getSiteConfig, rotateToken, rotateWebhookSecret, saveSiteConfig, SITE_EVENTS } from '../site/config.js';
import { deliverSiteEvent } from '../site/webhooks.js';
import { createTemplate } from '../templates/service.js';
import { badRequest, HttpError, parse } from './errors.js';

const requireAdmin = (req: FastifyRequest) => {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador mexe na integração com o site.');
};

export const CAMPAIGN_TEMPLATE = {
  body: 'Oi, {{1}}! {{2}} Toque em Quero para saber mais.',
  examples: ['Maria', 'Chegaram as novidades e reposições da semana na Oliver Cosméticos, com preço especial.'],
};

export async function integrationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/integration', async (req) => {
    requireAdmin(req);
    const [cfg, logs, sent, carts, tpl] = await Promise.all([
      getSiteConfig(deps.db),
      deps.db.siteWebhookLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      deps.db.siteMessage.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
      deps.db.abandonedCart.count({ where: { recoveredAt: null } }),
      deps.db.template.findFirst({ where: { status: { not: 'DELETED' } , name: (await getSiteConfig(deps.db)).campaignTemplate }, select: { name: true, status: true, rejectedReason: true } }),
    ]);
    const base = deps.env.PANEL_URL.replace(/\/$/, '');
    return {
      apiBase: `${base}/api/site/v1`,
      token: cfg.tokenHash ? { prefix: cfg.tokenPrefix, createdAt: cfg.tokenCreatedAt, lastUsedAt: cfg.lastUsedAt } : null,
      webhook: { url: cfg.webhookUrl, hasSecret: Boolean(cfg.webhookSecretEnc), events: cfg.events },
      allEvents: SITE_EVENTS,
      campaignTemplate: { name: cfg.campaignTemplate, template: tpl, body: CAMPAIGN_TEMPLATE.body },
      appIdSet: Boolean(deps.env.META_APP_ID),
      stats: { siteMessages7d: sent, openCarts: carts },
      logs,
    };
  });

  /** Gera uma chave nova (mostrada UMA vez; a anterior para de funcionar). */
  app.post('/integration/token', async (req) => {
    requireAdmin(req);
    return { token: await rotateToken(deps.db) };
  });

  app.put('/integration/webhook', async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        url: z.string().trim().max(300).refine((u) => !u || /^https:\/\//.test(u) || (deps.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)/.test(u)), 'use um link https do site'),
        events: z.array(z.enum(SITE_EVENTS)).default([...SITE_EVENTS]),
      }),
      req.body,
    );
    const cfg = await getSiteConfig(deps.db);
    await saveSiteConfig(deps.db, { ...cfg, webhookUrl: body.url, events: body.events });
    // primeira URL: já cria o segredo da assinatura
    const secret = body.url && !cfg.webhookSecretEnc ? await rotateWebhookSecret(deps.db, deps.env.ENCRYPTION_KEY) : null;
    return { ok: true, secret };
  });

  /** Segredo novo da assinatura (mostrado UMA vez). */
  app.post('/integration/webhook/secret', async (req) => {
    requireAdmin(req);
    return { secret: await rotateWebhookSecret(deps.db, deps.env.ENCRYPTION_KEY) };
  });

  app.post('/integration/webhook/test', async (req) => {
    requireAdmin(req);
    const r = await deliverSiteEvent(deps, { event: 'message.received', at: new Date().toISOString(), data: { test: true, phone: '+5500000000000', text: 'Teste do Oliver Hub' } });
    if (!r.ok) throw badRequest(r.error ?? 'O site não respondeu');
    return r;
  });

  /** Template de marketing com a arte no cabeçalho, para as campanhas do painel. */
  app.post('/integration/campaign-template', async (req) => {
    requireAdmin(req);
    const cfg = await getSiteConfig(deps.db);
    const existing = await deps.db.template.findFirst({ where: { name: cfg.campaignTemplate, status: { not: 'DELETED' } } });
    if (existing) return { name: existing.name, status: existing.status };
    if (!deps.env.META_APP_ID) throw badRequest('Falta META_APP_ID no .env (ID do app da Meta): ele é usado para enviar a imagem de exemplo do template.');
    const logo = [path.resolve(process.cwd(), 'assets/logo-oliver.png'), path.resolve(process.cwd(), 'apps/api/assets/logo-oliver.png')].find((p) => fs.existsSync(p));
    if (!logo) throw badRequest('Logo de exemplo não encontrada (apps/api/assets/logo-oliver.png).');
    const handle = await managementClient(deps).uploadTemplateSample(deps.env.META_APP_ID, fs.readFileSync(logo), 'image/png', 'arte-exemplo.png');
    const row = await createTemplate(deps, {
      name: cfg.campaignTemplate,
      language: 'pt_BR',
      category: 'MARKETING',
      headerFormat: 'IMAGE',
      headerHandle: handle,
      body: CAMPAIGN_TEMPLATE.body,
      bodyExamples: CAMPAIGN_TEMPLATE.examples,
      footer: 'Oliver Cosméticos',
      quickReplies: ['Quero'],
      addOptOutButton: true,
    });
    return { name: row.name, status: row.status };
  });
}
