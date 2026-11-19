import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { pollOrders } from './engine.js';

const log = childLogger('pedidos:jobs');

export const ORDERS_POLL_JOB = 'poll';

export function registerOrdersWorker(deps: Deps): void {
  deps.bus.process(
    QUEUES.orders,
    async () => {
      const r = await pollOrders(deps);
      if (r.sent || r.failed || r.skipped || r.baseline !== undefined) log.info(r, 'Rodada de avisos de pedido');
    },
    { concurrency: 1 },
  );
}

/** Uma rodada a cada ORDERS_POLL_SECONDS (jobId = fatia de tempo: API + worker juntos geram uma só). */
export function startOrdersScheduler(deps: Deps): () => void {
  const every = deps.env.ORDERS_POLL_SECONDS * 1000;
  const tick = () => {
    const slot = Math.floor(Date.now() / every);
    deps.bus
      .add(QUEUES.orders, ORDERS_POLL_JOB, {}, { jobId: `poll-${slot}`, attempts: 1, removeOnComplete: true })
      .catch((err: Error) => log.warn({ err: err.message }, 'Não foi possível agendar a rodada de avisos de pedido'));
  };
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, every);
  first.unref();
  timer.unref();
  log.info({ segundos: deps.env.ORDERS_POLL_SECONDS }, 'Avisos de pedido: leitura do Bling agendada');
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
