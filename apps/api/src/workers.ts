import { registerBlingWorker } from './bling/jobs.js';
import { registerCampaignWorker } from './campaigns/jobs.js';
import { registerOrdersWorker } from './orders/jobs.js';
import { registerChargesWorker } from './charges/jobs.js';
import { registerRelationWorker } from './relation/jobs.js';
import { registerSiteWorker } from './site/webhooks.js';
import { registerHealthWorker } from './team/health.js';
import { aiReplyEngine, registerBotWorker } from './bot/ai-engine.js';
import { echoReplyEngine, silentReplyEngine, type ReplyEngine } from './bot/reply-engine.js';
import type { Deps } from './deps.js';
import { createInboundProcessor } from './inbound/processor.js';
import { childLogger } from './lib/logger.js';
import { QUEUES } from './queue/index.js';
import type { InboundJob } from './webhook/routes.js';

const log = childLogger('workers');

export function selectReplyEngine(deps: Deps): ReplyEngine {
  switch (deps.env.BOT_MODE) {
    case 'off':
      return silentReplyEngine;
    case 'ai':
      return aiReplyEngine;
    default:
      return echoReplyEngine;
  }
}

export interface WorkerOptions {
  engine?: ReplyEngine;
}

/** Registra todos os consumidores de fila. */
export function registerWorkers(deps: Deps, opts: WorkerOptions = {}): void {
  const engine = opts.engine ?? selectReplyEngine(deps);
  const processInbound = createInboundProcessor(deps, engine);
  deps.bus.process<InboundJob>(QUEUES.inbound, (data) => processInbound(data), { concurrency: 5 });
  registerBlingWorker(deps);
  registerBotWorker(deps);
  registerCampaignWorker(deps);
  registerOrdersWorker(deps);
  registerChargesWorker(deps);
  registerRelationWorker(deps);
  registerSiteWorker(deps);
  registerHealthWorker(deps);
  log.info({ driver: deps.bus.driver, engine: engine.name }, 'Workers registrados');
}
