import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { logger } from './lib/logger.js';
import { HttpError } from './http/errors.js';
import { panelRoutes } from './http/panel-routes.js';
import { webhookRoutes } from './webhook/routes.js';

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger.child({ scope: 'http' }) as FastifyBaseLogger,
    trustProxy: true,
  });

  // Limite padrão para o painel (webhook e login têm limites próprios).
  // Precisa ser registrado ANTES do plugin de rate-limit, que lê a config no próprio onRoute.
  app.addHook('onRoute', (route) => {
    const config = (route.config ?? {}) as { rateLimit?: unknown };
    if (route.url.startsWith('/api/') && !config.rateLimit) {
      route.config = { ...config, rateLimit: { max: 300, timeWindow: '1 minute' } } as typeof route.config;
    }
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(ctx.ttl / 1000)} s.`),
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'Erro não tratado');
    reply.code(status).send({ error: status >= 500 ? 'Erro interno' : err.message });
  });

  app.get('/health', async (_req, reply) => {
    const [db, queue] = await Promise.all([
      deps.db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      deps.bus.ping(),
    ]);
    const ok = db && queue;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', db, queue, queueDriver: deps.bus.driver });
  });

  await app.register(webhookRoutes(deps));
  await app.register(panelRoutes(deps), { prefix: '/api' });
  return app;
}
