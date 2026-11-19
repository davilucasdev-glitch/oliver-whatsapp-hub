import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { childLogger } from '../lib/logger.js';
import type { AddJobOptions, JobHandler, ProcessOptions, QueueBus, QueueName } from './bus.js';

const log = childLogger('queue:bullmq');

export class BullMqBus implements QueueBus {
  readonly driver = 'bullmq' as const;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ConnectionOptions;

  constructor(redisUrl: string) {
    // maxRetriesPerRequest: null é exigido pelos Workers do BullMQ
    this.connection = { url: redisUrl, maxRetriesPerRequest: null };
  }

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: { removeOnComplete: { count: 2000 }, removeOnFail: { count: 5000 } },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T>(queue: QueueName, name: string, data: T, opts: AddJobOptions = {}): Promise<void> {
    await this.queue(queue).add(name, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? 3,
      backoff: { type: 'exponential', delay: opts.backoffMs ?? 2000 },
      ...(opts.removeOnComplete ? { removeOnComplete: true, removeOnFail: true } : {}),
    });
  }

  process<T>(queue: QueueName, handler: JobHandler<T>, opts: ProcessOptions = {}): void {
    const worker = new Worker(
      queue,
      async (job) => handler(job.data as T, { id: job.id ?? '', name: job.name, attempt: job.attemptsMade + 1 }),
      {
        connection: this.connection,
        concurrency: opts.concurrency ?? 1,
        ...(opts.limiter ? { limiter: { max: opts.limiter.max, duration: opts.limiter.durationMs } } : {}),
      },
    );
    worker.on('failed', (job, err) =>
      log.error({ queue, job: job?.name, id: job?.id, attempt: job?.attemptsMade, err: err.message }, 'Job falhou'),
    );
    worker.on('error', (err) => log.error({ queue, err: err.message }, 'Erro no worker'));
    this.workers.push(worker);
  }

  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let busy = 0;
      for (const q of this.queues.values()) {
        const c = await q.getJobCounts('waiting', 'active', 'delayed');
        busy += (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
      }
      if (busy === 0) return;
      if (Date.now() > deadline) throw new Error('Timeout esperando filas esvaziarem');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async ping(): Promise<boolean> {
    try {
      // Qualquer comando que exija o Redis responde; com timeout para não travar o /health.
      await Promise.race([
        this.queue('inbound').getJobCounts('waiting'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
