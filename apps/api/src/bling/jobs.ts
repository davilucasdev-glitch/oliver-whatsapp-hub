import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { blingConfigured } from './client.js';
import { syncProducts } from './sync.js';

const log = childLogger('bling:jobs');

export interface BlingSyncJob {
  full?: boolean;
  trigger: 'agendado' | 'manual' | 'conexao' | 'cli';
}

export const BLING_SYNC_JOB = 'sync-products';

export async function enqueueProductSync(deps: Deps, job: BlingSyncJob, jobId?: string): Promise<void> {
  await deps.bus.add<BlingSyncJob>(QUEUES.bling, BLING_SYNC_JOB, job, { jobId, attempts: 1 });
}

export function registerBlingWorker(deps: Deps): void {
  deps.bus.process<BlingSyncJob>(
    QUEUES.bling,
    async (data) => {
      const auth = await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } });
      if (!auth) {
        if (data.trigger !== 'agendado') log.warn('Sync pedido, mas o Bling não está conectado');
        return;
      }
      try {
        await syncProducts(deps, { full: data.full, trigger: data.trigger });
      } catch (err) {
        // O status com o erro fica gravado para o painel; não repetimos o job (o próximo horário tenta de novo).
        log.warn({ err: (err as Error).message }, 'Sync de produtos não concluído');
      }
    },
    { concurrency: 1 },
  );
}

/**
 * Agenda o sync a cada BLING_SYNC_INTERVAL_MINUTES. O jobId é o "horário" do ciclo, então vários
 * processos (API + worker) agendando ao mesmo tempo geram um job só.
 */
export function startBlingScheduler(deps: Deps): () => void {
  if (!blingConfigured(deps.env)) {
    log.info('BLING_CLIENT_ID/SECRET vazios: sync automático do Bling desligado');
    return () => {};
  }
  const intervalMs = deps.env.BLING_SYNC_INTERVAL_MINUTES * 60_000;
  const tick = () => {
    const slot = Math.floor(Date.now() / intervalMs);
    enqueueProductSync(deps, { trigger: 'agendado' }, `auto-${slot}`).catch((err: Error) =>
      log.warn({ err: err.message }, 'Não foi possível agendar o sync do Bling'),
    );
  };
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  log.info({ minutos: deps.env.BLING_SYNC_INTERVAL_MINUTES }, 'Sync automático do Bling agendado');
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
