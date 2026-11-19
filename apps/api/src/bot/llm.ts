import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { getSetting, setSetting } from '../settings.js';

/** O que o bot precisa do modelo (permite trocar por um modelo falso nos testes). */
export interface LlmClient {
  readonly model: string;
  create(params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>): Promise<Anthropic.Message>;
}

export class BotNotConfiguredError extends Error {
  constructor() {
    super('Chave da API da Anthropic não configurada (Bot de IA → Configurações ou ANTHROPIC_API_KEY no .env).');
    this.name = 'BotNotConfiguredError';
  }
}

const KEY_SETTING = 'anthropic.apiKeyEnc';

/** Chave salva pelo painel (criptografada) tem prioridade sobre a do .env. */
export async function resolveApiKey(db: PrismaClient, env: Env): Promise<{ key: string; source: 'painel' | 'env' } | null> {
  const enc = await getSetting<string | null>(db, KEY_SETTING, null);
  if (enc) return { key: decrypt(enc, env.ENCRYPTION_KEY), source: 'painel' };
  if (env.ANTHROPIC_API_KEY) return { key: env.ANTHROPIC_API_KEY, source: 'env' };
  return null;
}

export async function saveApiKey(db: PrismaClient, env: Env, key: string | null): Promise<void> {
  await setSetting(db, KEY_SETTING, key ? encrypt(key.trim(), env.ENCRYPTION_KEY) : null);
  cached = undefined;
}

export async function apiKeyInfo(db: PrismaClient, env: Env) {
  const k = await resolveApiKey(db, env);
  return k ? { configured: true, source: k.source, last4: k.key.slice(-4) } : { configured: false, source: null, last4: null };
}

let cached: { key: string; client: Anthropic } | undefined;

/** Cliente real da Anthropic (SDK oficial). Repete sozinho em 429/5xx (maxRetries). */
export async function anthropicLlm(db: PrismaClient, env: Env): Promise<LlmClient> {
  const k = await resolveApiKey(db, env);
  if (!k) throw new BotNotConfiguredError();
  if (cached?.key !== k.key) {
    cached = { key: k.key, client: new Anthropic({ apiKey: k.key, baseURL: env.ANTHROPIC_BASE_URL, maxRetries: 3, timeout: 60_000 }) };
  }
  const client = cached.client;
  return {
    model: env.ANTHROPIC_MODEL,
    create: (params) => client.messages.create({ ...params, model: env.ANTHROPIC_MODEL }),
  };
}
