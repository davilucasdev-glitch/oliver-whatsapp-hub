import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { runCampaignTick } from './engine.js';

const log = childLogger('campaigns:jobs');

export const CAMPAIGN_TICK_JOB = 'tick';

export function registerCampaignWorker(deps: Deps): void {
  deps.bus.process(
    QUEUES.campaign,
    async () => {
      const r = await runCampaignTick(deps);
      if (r.sent || r.failed || r.started || r.completed) log.debug(r, 'Rodada de campanhas');
    },
    { concurrency: 1 },
  );
}

/**
 * Uma rodada a cada CAMPAIGN_TICK_MS. O jobId é a "fatia" de tempo, então API + worker agendando juntos
 * geram uma rodada só; o envio em si também é protegido por reserva no banco.
 */
export function startCampaignScheduler(deps: Deps): () => void {
  const every = deps.env.CAMPAIGN_TICK_MS;
  const timer = setInterval(() => {
    const slot = Math.floor(Date.now() / every);
    deps.bus
      .add(QUEUES.campaign, CAMPAIGN_TICK_JOB, {}, { jobId: `tick-${slot}`, attempts: 1, removeOnComplete: true })
      .catch((err: Error) => log.warn({ err: err.message }, 'Não foi possível agendar a rodada de campanhas'));
  }, every);
  timer.unref();
  log.info({ ms: every }, 'Motor de campanhas ligado');
  return () => clearInterval(timer);
}
