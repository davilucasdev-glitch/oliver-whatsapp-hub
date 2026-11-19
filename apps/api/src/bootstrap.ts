import { env } from './config/env.js';
import type { Deps } from './deps.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { createQueueBus } from './queue/index.js';
import { createProviderFactory } from './whatsapp/registry.js';

export function createDeps(): Deps {
  const e = env();
  return { env: e, db: prisma(), bus: createQueueBus(e), providers: createProviderFactory(e) };
}

export async function shutdown(deps: Deps): Promise<void> {
  await deps.bus.close();
  await disconnectPrisma();
}
