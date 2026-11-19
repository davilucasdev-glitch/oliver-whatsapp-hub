import { describe, expect, it } from 'vitest';
import { MemoryQueueBus } from '../src/queue/memory-bus.js';

describe('fila em memória', () => {
  it('ignora job com jobId repetido (idempotência)', async () => {
    const bus = new MemoryQueueBus();
    const seen: number[] = [];
    bus.process<number>('inbound', async (n) => void seen.push(n));
    await bus.add('inbound', 'x', 1, { jobId: 'a' });
    await bus.add('inbound', 'x', 2, { jobId: 'a' });
    await bus.add('inbound', 'x', 3, { jobId: 'b' });
    await bus.drain();
    expect(seen.sort()).toEqual([1, 3]);
    await bus.close();
  });

  it('tenta de novo com backoff até dar certo', async () => {
    const bus = new MemoryQueueBus();
    let calls = 0;
    bus.process('inbound', async () => {
      calls++;
      if (calls < 3) throw new Error('falha temporária');
    });
    await bus.add('inbound', 'x', {}, { attempts: 5, backoffMs: 5 });
    await bus.drain();
    expect(calls).toBe(3);
    await bus.close();
  });

  it('respeita o limitador de taxa', async () => {
    const bus = new MemoryQueueBus();
    const times: number[] = [];
    bus.process('campaign', async () => void times.push(Date.now()), { concurrency: 5, limiter: { max: 2, durationMs: 150 } });
    for (let i = 0; i < 5; i++) await bus.add('campaign', 'send', i);
    const start = Date.now();
    await bus.drain();
    expect(times).toHaveLength(5);
    // 5 jobs a 2 por 150ms → precisa de pelo menos 2 janelas completas
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    await bus.close();
  });
});
