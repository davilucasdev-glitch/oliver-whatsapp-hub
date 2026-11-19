import { createDeps, shutdown } from './bootstrap.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';
import { startBlingScheduler } from './bling/jobs.js';
import { startCampaignScheduler } from './campaigns/jobs.js';
import { startOrdersScheduler } from './orders/jobs.js';
import { startChargesScheduler } from './charges/jobs.js';
import { startRelationScheduler } from './relation/jobs.js';
import { startHealthScheduler } from './team/health.js';
import { registerWorkers } from './workers.js';

async function main(): Promise<void> {
  const deps = createDeps();
  const app = await buildServer(deps);

  // Com fila em memória os workers precisam rodar no mesmo processo.
  if (deps.env.RUN_WORKERS_IN_API || deps.bus.driver === 'memory') {
    registerWorkers(deps);
    startBlingScheduler(deps);
    startCampaignScheduler(deps);
    startOrdersScheduler(deps);
    startChargesScheduler(deps);
    startRelationScheduler(deps);
    startHealthScheduler(deps);
  }

  await app.listen({ port: deps.env.PORT, host: deps.env.HOST });
  logger.info({ port: deps.env.PORT, queue: deps.bus.driver, bot: deps.env.BOT_MODE }, 'API no ar');

  const stop = async (signal: string) => {
    logger.info({ signal }, 'Encerrando API');
    await app.close();
    await shutdown(deps);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'Falha ao iniciar a API');
  process.exit(1);
});
