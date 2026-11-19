import type { Env } from '../config/env.js';
import { BullMqBus } from './bullmq-bus.js';
import type { QueueBus } from './bus.js';
import { MemoryQueueBus } from './memory-bus.js';

export * from './bus.js';

export function createQueueBus(cfg: Pick<Env, 'QUEUE_DRIVER' | 'REDIS_URL'>): QueueBus {
  return cfg.QUEUE_DRIVER === 'memory' ? new MemoryQueueBus() : new BullMqBus(cfg.REDIS_URL);
}
