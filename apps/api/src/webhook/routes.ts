import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { verifyMetaSignature } from '../whatsapp/signature.js';
import type { MetaWebhookPayload } from '../whatsapp/webhook-types.js';
import { extractEvents } from './extract.js';

const log = childLogger('webhook');

export interface InboundJob {
  eventId: string;
}

/**
 * GET  /webhook — verificação (hub.challenge) com META_VERIFY_TOKEN
 * POST /webhook — valida X-Hub-Signature-256, grava cada evento uma única vez
 *                 (idempotência por chave) e enfileira; responde 200 imediatamente.
 */
export function webhookRoutes(deps: Deps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    // Neste escopo, JSON chega como Buffer: precisamos do corpo bruto para o HMAC.
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 3 * 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    const rateLimit = { max: deps.env.WEBHOOK_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };

    app.get('/webhook', { config: { rateLimit } }, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === deps.env.META_VERIFY_TOKEN) {
        log.info('Webhook verificado pela Meta');
        return reply.code(200).type('text/plain').send(q['hub.challenge'] ?? '');
      }
      log.warn({ mode: q['hub.mode'] }, 'Verificação de webhook recusada (verify token incorreto)');
      return reply.code(403).send({ error: 'verify token inválido' });
    });

    app.post('/webhook', { config: { rateLimit } }, async (req, reply) => {
      const raw = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(raw)) return reply.code(400).send({ error: 'corpo JSON esperado' });

      const signature = req.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(raw, typeof signature === 'string' ? signature : undefined, deps.env.META_APP_SECRET)) {
        log.warn({ ip: req.ip }, 'Assinatura do webhook inválida');
        return reply.code(401).send({ error: 'assinatura inválida' });
      }

      let payload: MetaWebhookPayload;
      try {
        payload = JSON.parse(raw.toString('utf8')) as MetaWebhookPayload;
      } catch {
        return reply.code(400).send({ error: 'JSON inválido' });
      }

      const events = extractEvents(payload);
      let queued = 0;
      for (const ev of events) {
        try {
          const row = await deps.db.webhookEvent.create({
            data: { eventKey: ev.key, kind: ev.kind, payload: ev as unknown as Prisma.InputJsonValue },
            select: { id: true },
          });
          await deps.bus.add<InboundJob>(QUEUES.inbound, ev.kind, { eventId: row.id }, { jobId: row.id, attempts: 5 });
          queued++;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            log.debug({ key: ev.key }, 'Evento duplicado ignorado');
            continue;
          }
          // Erro de banco/fila: devolve 500 para a Meta reenviar depois.
          log.error({ err: (err as Error).message, key: ev.key }, 'Falha ao registrar evento do webhook');
          return reply.code(500).send({ error: 'falha temporária' });
        }
      }
      log.debug({ total: events.length, queued }, 'Webhook recebido');
      return reply.code(200).send({ received: events.length, queued });
    });
  };
}
