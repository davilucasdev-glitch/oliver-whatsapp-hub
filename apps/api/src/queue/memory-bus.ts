import { randomUUID } from 'node:crypto';
import { childLogger } from '../lib/logger.js';
import type { AddJobOptions, JobHandler, ProcessOptions, QueueBus, QueueName } from './bus.js';

interface MemJob {
  id: string;
  name: string;
  data: unknown;
  attempt: number;
  attempts: number;
  backoffMs: number;
  runAt: number;
  removeOnComplete: boolean;
}

interface MemQueue {
  pending: MemJob[];
  running: number;
  handler?: JobHandler<unknown>;
  opts: Required<Pick<ProcessOptions, 'concurrency'>> & Pick<ProcessOptions, 'limiter'>;
  startedAt: number[]; // timestamps para o limitador
  timer?: NodeJS.Timeout;
}

const log = childLogger('queue:memory');

export class MemoryQueueBus implements QueueBus {
  readonly driver = 'memory' as const;
  private readonly queues = new Map<QueueName, MemQueue>();
  private readonly knownIds = new Set<string>();
  private closed = false;

  private q(name: QueueName): MemQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = { pending: [], running: 0, opts: { concurrency: 1 }, startedAt: [] };
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T>(queue: QueueName, name: string, data: T, opts: AddJobOptions = {}): Promise<void> {
    if (this.closed) throw new Error('Fila fechada');
    const id = opts.jobId ?? randomUUID();
    const key = `${queue}:${id}`;
    if (this.knownIds.has(key)) return; // dedupe por jobId
    this.knownIds.add(key);
    this.q(queue).pending.push({
      id,
      name,
      data,
      attempt: 0,
      attempts: opts.attempts ?? 3,
      backoffMs: opts.backoffMs ?? 200,
      runAt: Date.now() + (opts.delayMs ?? 0),
      removeOnComplete: opts.removeOnComplete ?? false,
    });
    this.schedule(queue);
  }

  process<T>(queue: QueueName, handler: JobHandler<T>, opts: ProcessOptions = {}): void {
    const q = this.q(queue);
    q.handler = handler as JobHandler<unknown>;
    q.opts = { concurrency: opts.concurrency ?? 1, limiter: opts.limiter };
    this.schedule(queue);
  }

  private schedule(queue: QueueName, delay = 0): void {
    const q = this.q(queue);
    if (q.timer || this.closed) return;
    q.timer = setTimeout(() => {
      q.timer = undefined;
      this.pump(queue);
    }, delay);
  }

  private pump(queue: QueueName): void {
    const q = this.q(queue);
    if (!q.handler || this.closed) return;
    const now = Date.now();

    while (q.running < q.opts.concurrency) {
      // limitador de taxa
      if (q.opts.limiter) {
        const windowStart = now - q.opts.limiter.durationMs;
        q.startedAt = q.startedAt.filter((t) => t > windowStart);
        if (q.startedAt.length >= q.opts.limiter.max) {
          const wait = (q.startedAt[0] ?? now) + q.opts.limiter.durationMs - now;
          this.schedule(queue, Math.max(wait, 5));
          return;
        }
      }
      const idx = q.pending.findIndex((j) => j.runAt <= now);
      if (idx === -1) {
        const next = q.pending.reduce<number | undefined>((m, j) => (m === undefined || j.runAt < m ? j.runAt : m), undefined);
        if (next !== undefined) this.schedule(queue, Math.max(next - now, 5));
        return;
      }
      const [job] = q.pending.splice(idx, 1);
      if (!job) return;
      q.running++;
      q.startedAt.push(Date.now());
      void this.run(queue, q, job);
    }
  }

  private async run(queue: QueueName, q: MemQueue, job: MemJob): Promise<void> {
    job.attempt++;
    try {
      await q.handler!(job.data, { id: job.id, name: job.name, attempt: job.attempt });
      if (job.removeOnComplete) this.knownIds.delete(`${queue}:${job.id}`);
    } catch (err) {
      if (job.attempt < job.attempts) {
        job.runAt = Date.now() + job.backoffMs * 2 ** (job.attempt - 1);
        q.pending.push(job);
        log.warn({ queue, job: job.name, attempt: job.attempt, err: (err as Error).message }, 'Job falhou, nova tentativa');
      } else {
        log.error({ queue, job: job.name, err: (err as Error).message }, 'Job falhou definitivamente');
        if (job.removeOnComplete) this.knownIds.delete(`${queue}:${job.id}`);
      }
    } finally {
      q.running--;
      this.schedule(queue);
    }
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = [...this.queues.values()].some((q) => q.running > 0 || (q.handler && q.pending.length > 0));
      if (!busy) return;
      if (Date.now() > deadline) throw new Error('Timeout esperando filas esvaziarem');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async ping(): Promise<boolean> {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.queues.values()) if (q.timer) clearTimeout(q.timer);
  }
}
