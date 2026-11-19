import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { fetchMessageMedia } from '../inbox/service.js';
import { getSiteConfig, saveSiteConfig, tokenMatches } from '../site/config.js';
import { createPainelCampaign, siteCart, siteCartRecovered, siteOptIn, siteOptOuts, siteSend, siteTemplates } from '../site/service.js';
import { HttpError, notFound, parse } from './errors.js';

/**
 * API para o site/painel da Oliver: /api/site/v1/*
 * Autenticação: cabeçalho "Authorization: Bearer <chave do site>" (nunca na URL).
 * Gera a chave em Integração com o site (só administrador).
 */

let lastTouch = 0;

async function siteAuth(deps: Deps, req: FastifyRequest) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const cfg = await getSiteConfig(deps.db);
  if (!tokenMatches(cfg, token)) throw new HttpError(401, 'Chave do site ausente ou inválida (cabeçalho Authorization: Bearer ...).');
  // "último uso" sem gravar a cada chamada
  if (Date.now() - lastTouch > 60_000) {
    lastTouch = Date.now();
    await saveSiteConfig(deps.db, { ...cfg, lastUsedAt: new Date().toISOString() });
  }
}

const phone = z.string().trim().min(8, 'informe o telefone').max(30);

export async function siteRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // arte das campanhas do painel: link público (id aleatório) para a Meta baixar
  app.get('/public/art/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[a-f0-9]{32}$/.test(id)) throw notFound();
    const art = await deps.db.campaignArt.findUnique({ where: { id } });
    if (!art) throw notFound();
    return reply.type(art.mime).header('Cache-Control', 'public, max-age=86400').send(Buffer.from(art.data));
  });

  await app.register(
    async (site) => {
      site.addHook('onRequest', async (_req, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
      });
      site.addHook('preHandler', async (req) => siteAuth(deps, req));

      site.get('/ping', async () => ({ ok: true, hub: 'Oliver WhatsApp Hub' }));

      site.get('/templates', async () => ({ templates: await siteTemplates(deps) }));

      // anexo em base64 (PDF até 16 MB) cabe no corpo
      site.post('/messages', { bodyLimit: 24 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
        const body = parse(
          z.object({
            phone,
            template: z.string().trim().min(1).max(512),
            variables: z.array(z.string().max(1000)).max(20).default([]),
            name: z.string().trim().max(120).nullish(),
            ref: z.string().trim().min(1).max(120).nullish(),
            attachment: z
              .object({ url: z.string().url().optional(), base64: z.string().max(23_000_000).optional(), mime: z.string().max(100).optional(), filename: z.string().max(200).optional() })
              .nullish(),
          }),
          req.body,
        );
        const r = await siteSend(deps, body);
        return reply.code(r.status === 'FAILED' ? 422 : 201).send(r);
      });

      site.post('/opt-in', async (req) => {
        const body = parse(z.object({ phone, name: z.string().trim().max(120).nullish(), source: z.string().trim().min(2, 'informe de onde veio o consentimento (ex.: checkout)').max(80), at: z.string().nullish() }), req.body);
        return siteOptIn(deps, body);
      });

      site.get('/opt-outs', async (req) => {
        const { since } = parse(z.object({ since: z.string().optional() }), req.query);
        return { optOuts: await siteOptOuts(deps, since) };
      });

      site.post('/carts', async (req, reply) => {
        const body = parse(
          z.object({
            ref: z.string().trim().min(1).max(120),
            phone,
            name: z.string().trim().max(120).nullish(),
            items: z.array(z.object({ name: z.string().trim().min(1).max(200), qty: z.number().int().min(1).max(999) })).min(1).max(50),
            total: z.number().min(0).nullish(),
            link: z.string().url('link do carrinho inválido'),
          }),
          req.body,
        );
        return reply.code(201).send(await siteCart(deps, body));
      });

      site.post('/carts/:ref/recovered', async (req) => {
        const { ref } = req.params as { ref: string };
        return siteCartRecovered(deps, ref);
      });

      site.post('/campaigns', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
        const body = parse(
          z.object({
            name: z.string().trim().min(2).max(80),
            text: z.string().trim().min(5, 'texto da campanha muito curto').max(700, 'texto: máx. 700 caracteres'),
            segment: z.enum(['varejo', 'atacado', 'todos']),
            phones: z.array(z.string().max(30)).min(1, 'lista de destino vazia').max(5000),
            image: z.object({ url: z.string().url().optional(), base64: z.string().max(7_000_000).optional(), mime: z.string().max(40).optional() }),
            ref: z.string().trim().min(1).max(120).nullish(),
          }),
          req.body,
        );
        return reply.code(201).send(await createPainelCampaign(deps, body));
      });

      /** Mídia de uma mensagem recebida (comprovante) — o id vem no aviso message.received. */
      site.get('/media/:messageId', async (req, reply) => {
        const { messageId } = req.params as { messageId: string };
        const media = await fetchMessageMedia(deps, messageId);
        return reply.type(media.mimeType).send(media.data);
      });
    },
    { prefix: '/site/v1' },
  );
}
