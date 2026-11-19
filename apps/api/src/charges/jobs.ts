import { blingConfigured } from '../bling/client.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { syncReceivables } from './sync.js';

const log = childLogger('cobranca:jobs');
const EVERY_MS = 15 * 60_000;

export function registerChargesWorker(deps: Deps): void {
  deps.bus.process(
    QUEUES.charges,
    async () => {
      if (!(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }))) return;
      await syncReceivables(deps).catch((err: Error) => log.warn({ err: err.message }, 'Sync de contas a receber falhou'));
    },
    { concurrency: 1 },
  );
}

/** Copia as contas a receber do Bling a cada 15 min (só lê; nada é enviado sem clique). */
export function startChargesScheduler(deps: Deps): () => void {
  if (!blingConfigured(deps.env)) return () => {};
  const tick = () => {
    const slot = Math.floor(Date.now() / EVERY_MS);
    deps.bus
      .add(QUEUES.charges, 'sync', {}, { jobId: `charges-${slot}`, attempts: 1, removeOnComplete: true })
      .catch((err: Error) => log.warn({ err: err.message }, 'Não foi possível agendar o sync de contas a receber'));
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
