import { blingConfigured } from '../bling/client.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { syncRelationData } from './service.js';

const log = childLogger('relacionamento:jobs');
const EVERY_MS = 6 * 3600_000;

export function registerRelationWorker(deps: Deps): void {
  deps.bus.process(
    QUEUES.relation,
    async () => {
      if (!(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }))) return;
      await syncRelationData(deps).catch((err: Error) => log.warn({ err: err.message }, 'Leitura de aniversários/últimas compras falhou'));
    },
    { concurrency: 1 },
  );
}

/** Lê aniversário e última compra de quem deu opt-in a cada 6 h (só lê; nada é enviado sem clique). */
export function startRelationScheduler(deps: Deps): () => void {
  if (!blingConfigured(deps.env)) return () => {};
  const tick = () => {
    const slot = Math.floor(Date.now() / EVERY_MS);
    deps.bus
      .add(QUEUES.relation, 'sync', {}, { jobId: `relation-${slot}`, attempts: 1, removeOnComplete: true })
      .catch((err: Error) => log.warn({ err: err.message }, 'Não foi possível agendar a leitura de relacionamento'));
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
