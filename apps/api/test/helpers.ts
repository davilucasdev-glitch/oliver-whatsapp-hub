import { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import { loadEnv, type Env } from '../src/config/env.js';
import type { Deps } from '../src/deps.js';
import { startMockBling, type MockBling } from '../src/dev/mock-bling.js';
import { startMockMeta, type MockMeta } from '../src/dev/mock-meta.js';
import { MemoryQueueBus } from '../src/queue/memory-bus.js';
import { buildServer } from '../src/server.js';
import { signMetaPayload } from '../src/whatsapp/signature.js';
import { createProviderFactory } from '../src/whatsapp/registry.js';
import { registerWorkers } from '../src/workers.js';

export const TEST_SECRET = 'test-app-secret';
export const TEST_VERIFY = 'test-verify-token';
export const WABA = 'WABA_TEST';
export const PNID = 'PNID_TEST';
export const TEST_SETUP_TOKEN = 'codigo-instalacao-teste';
export const ADMIN = { email: 'oliver@exemplo.com.br', password: 'Senha-Forte-2026' };

/** Cria o primeiro acesso e devolve um cliente autenticado (cookie + cabeçalho anti-CSRF). */
export async function loginAsAdmin(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { ...ADMIN, setupToken: TEST_SETUP_TOKEN },
  });
  if (res.statusCode !== 200) throw new Error(`setup falhou: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'oh_session');
  if (!cookie) throw new Error('cookie de sessão ausente');
  const headers = { cookie: `oh_session=${cookie.value}`, 'x-oliver-panel': '1' };
  return {
    cookie,
    call: (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) }),
  };
}

export interface TestContext {
  env: Env;
  db: PrismaClient;
  bus: MemoryQueueBus;
  deps: Deps;
  app: FastifyInstance;
  meta: MockMeta;
  bling: MockBling;
  postWebhook(payload: unknown, opts?: { secret?: string; signature?: string }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const meta = await startMockMeta();
  const bling = await startMockBling();
  const databaseUrl = inject('databaseUrl');
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    QUEUE_DRIVER: 'memory',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    META_GRAPH_BASE_URL: meta.url,
    META_APP_SECRET: TEST_SECRET,
    META_VERIFY_TOKEN: TEST_VERIFY,
    META_ACCESS_TOKEN: 'token-de-teste',
    META_WABA_ID: WABA,
    META_DEFAULT_PHONE_NUMBER_ID: PNID,
    BOT_MODE: 'echo',
    SETUP_TOKEN: TEST_SETUP_TOKEN,
    BLING_CLIENT_ID: bling.clientId,
    BLING_CLIENT_SECRET: bling.clientSecret,
    BLING_API_BASE_URL: `${bling.url}/Api/v3`,
    BLING_OAUTH_BASE_URL: `${bling.url}/Api/v3/oauth`,
    BLING_MIN_INTERVAL_MS: '0',
    LOGIN_RATE_LIMIT: process.env.TEST_LOGIN_RATE_LIMIT ?? '1000',
    ...overrides,
  });
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const bus = new MemoryQueueBus();
  const deps: Deps = { env, db, bus, providers: createProviderFactory(env) };
  registerWorkers(deps);
  const app = await buildServer(deps);

  return {
    env,
    db,
    bus,
    deps,
    app,
    meta,
    bling,
    postWebhook(payload, opts = {}) {
      const raw = JSON.stringify(payload);
      return app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': opts.signature ?? signMetaPayload(raw, opts.secret ?? TEST_SECRET),
        },
        payload: raw,
      });
    },
    async close() {
      await app.close();
      await bus.close();
      await db.$disconnect();
      await meta.close();
      await bling.close();
    },
  };
}

/** Limpa todas as tabelas entre testes. */
export async function resetDb(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  }
}

export async function seedNumber(db: PrismaClient, overrides: Partial<{ botEnabled: boolean; role: 'ATTENDANCE' | 'CAMPAIGNS' | 'BOTH' }> = {}) {
  return db.phoneNumber.create({
    data: {
      phoneNumberId: PNID,
      wabaId: WABA,
      displayName: 'Oliver Atendimento',
      displayPhone: '+15550001111',
      status: 'CONNECTED',
      qualityRating: 'HIGH',
      ...overrides,
    },
  });
}

/** Conecta o Bling simulado pelo mesmo caminho do navegador e espera o primeiro sync. */
export async function connectBling(ctx: TestContext, call: Awaited<ReturnType<typeof loginAsAdmin>>['call']): Promise<void> {
  const res = await call('POST', '/api/bling/connect');
  const authorize = await fetch(res.json<{ url: string }>().url, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  await ctx.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
  await ctx.bus.drain();
}
