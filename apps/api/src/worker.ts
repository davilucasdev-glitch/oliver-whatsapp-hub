import { createDeps, shutdown } from './bootstrap.js';
import { logger } from './lib/logger.js';
import { startBlingScheduler } from './bling/jobs.js';
import { startCampaignScheduler } from './campaigns/jobs.js';
import { startOrdersScheduler } from './orders/jobs.js';
import { startChargesScheduler } from './charges/jobs.js';
import { startRelationScheduler } from './relation/jobs.js';
import { registerWorkers } from './workers.js';

/** Processo dedicado aos workers (produção com Redis). */
async function main(): Promise<void> {
  const deps = createDeps();
  if (deps.bus.driver === 'memory') {
    throw new Error('O processo worker separado exige QUEUE_DRIVER=bullmq (com memory os workers rodam dentro da API).');
  }
  registerWorkers(deps);
  startBlingScheduler(deps);
  startCampaignScheduler(deps);
  startOrdersScheduler(deps);
  startChargesScheduler(deps);
  startRelationScheduler(deps);
  logger.info('Worker no ar');

  const stop = async (signal: string) => {
    logger.info({ signal }, 'Encerrando worker');
    await shutdown(deps);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'Falha ao iniciar o worker');
  process.exit(1);
});
