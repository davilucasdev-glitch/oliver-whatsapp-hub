import type { PrismaClient } from '@prisma/client';
import type { LlmClient } from './bot/llm.js';
import type { Env } from './config/env.js';
import type { QueueBus } from './queue/index.js';
import type { ProviderFactory } from './whatsapp/registry.js';

/** Dependências compartilhadas (injetadas para facilitar testes). */
export interface Deps {
  env: Env;
  db: PrismaClient;
  bus: QueueBus;
  providers: ProviderFactory;
  /** troca o cliente da Anthropic (testes usam um modelo falso). Padrão: SDK oficial. */
  llmFactory?: (deps: Deps) => Promise<LlmClient>;
}
