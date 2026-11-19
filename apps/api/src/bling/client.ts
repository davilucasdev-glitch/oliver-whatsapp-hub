import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { childLogger } from '../lib/logger.js';

/**
 * Cliente da API v3 do Bling.
 * - OAuth2 (authorization_code + refresh_token). Tokens guardados com AES-256-GCM (tabela BlingAuth).
 * - O access_token dura ~6h; renovamos sozinhos quando faltam menos de 5 min ou quando o Bling responde 401.
 *   O Bling troca o refresh_token a cada renovação, então o novo é sempre gravado.
 * - Respeita o limite do Bling (3 chamadas/s) com um intervalo mínimo entre chamadas e repete com
 *   backoff exponencial em 429, 5xx e falhas de rede.
 */

const log = childLogger('bling');

export interface BlingTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export class BlingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | undefined,
    readonly retryable: boolean,
    readonly fields?: unknown,
  ) {
    super(message);
    this.name = 'BlingApiError';
  }
}

/** Sem conexão (nunca conectado, desconectado ou refresh_token expirado). */
export class BlingNotConnectedError extends Error {
  constructor(message = 'O Bling não está conectado. Conecte em Produtos > Conectar Bling.') {
    super(message);
    this.name = 'BlingNotConnectedError';
  }
}

type BlingDeps = { env: Env; db: PrismaClient };

export function blingConfigured(env: Env): boolean {
  return Boolean(env.BLING_CLIENT_ID && env.BLING_CLIENT_SECRET);
}

export function blingRedirectUri(env: Env): string {
  return env.BLING_REDIRECT_URI ?? `${env.PANEL_URL.replace(/\/$/, '')}/api/bling/callback`;
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const url = new URL(`${env.BLING_OAUTH_BASE_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.BLING_CLIENT_ID);
  url.searchParams.set('state', state);
  // O Bling usa o link cadastrado no app; mandamos junto para deixar explícito.
  url.searchParams.set('redirect_uri', blingRedirectUri(env));
  return url.toString();
}

function errorInfo(body: unknown): { type?: string; message?: string; fields?: unknown } {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  // Formato da API: { error: { type, message, description, fields } }
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    const msg = [e.message, e.description].filter((x) => typeof x === 'string' && x).join(' — ');
    return { type: typeof e.type === 'string' ? e.type : undefined, message: msg || undefined, fields: e.fields };
  }
  // Formato OAuth: { error: "invalid_grant", error_description }
  if (typeof b.error === 'string') {
    return { type: b.error, message: typeof b.error_description === 'string' ? b.error_description : b.error };
  }
  return {};
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<BlingTokens> {
  if (!blingConfigured(env)) throw new BlingNotConnectedError('Preencha BLING_CLIENT_ID e BLING_CLIENT_SECRET no .env.');
  const basic = Buffer.from(`${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${env.BLING_OAUTH_BASE_URL}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '1.0',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new BlingApiError(`Sem resposta do Bling (${(err as Error).message})`, 0, 'network', true);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const info = errorInfo(body);
    throw new BlingApiError(info.message ?? `Bling recusou o token (HTTP ${res.status})`, res.status, info.type, res.status >= 500);
  }
  const t = body as Partial<BlingTokens>;
  if (!t.access_token || !t.refresh_token) throw new BlingApiError('Resposta de token do Bling sem access_token/refresh_token', res.status, 'invalid_response', false);
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: Number(t.expires_in ?? 21600), scope: t.scope };
}

export function exchangeCode(env: Env, code: string): Promise<BlingTokens> {
  return tokenRequest(env, { grant_type: 'authorization_code', code });
}

export function refreshTokens(env: Env, refreshToken: string): Promise<BlingTokens> {
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function saveTokens(deps: BlingDeps, tokens: BlingTokens, kind: 'connect' | 'refresh'): Promise<void> {
  const key = deps.env.ENCRYPTION_KEY;
  const data = {
    accessTokenEnc: encrypt(tokens.access_token, key),
    refreshTokenEnc: encrypt(tokens.refresh_token, key),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scope: tokens.scope ?? null,
  };
  await deps.db.blingAuth.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...data },
    update: kind === 'connect' ? { ...data, connectedAt: new Date(), lastRefreshAt: null } : { ...data, lastRefreshAt: new Date() },
  });
}

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];

export function buildQuery(query: Record<string, QueryValue> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) parts.push(`${encodeURIComponent(`${k}[]`)}=${encodeURIComponent(String(item))}`);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export interface BlingClientOptions {
  sleep?: (ms: number) => Promise<void>;
  /** base do backoff exponencial (ms) */
  backoffMs?: number;
}

export class BlingClient {
  private gate: Promise<void> = Promise.resolve();
  private lastCallAt = 0;
  private refreshing?: Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  /** contador de chamadas HTTP feitas (para relatórios do sync) */
  calls = 0;

  constructor(
    private readonly deps: BlingDeps,
    opts: BlingClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoffMs = opts.backoffMs ?? 1000;
  }

  /** Espera a vez (no máximo ~3 chamadas/s por processo). */
  private throttle(): Promise<void> {
    const min = this.deps.env.BLING_MIN_INTERVAL_MS;
    this.gate = this.gate.then(async () => {
      const wait = this.lastCallAt + min - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = Date.now();
    });
    return this.gate;
  }

  /** Access token válido (renova se estiver perto de vencer). */
  async accessToken(force = false): Promise<string> {
    const row = await this.deps.db.blingAuth.findUnique({ where: { id: 'default' } });
    if (!row) throw new BlingNotConnectedError();
    if (!force && row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return decrypt(row.accessTokenEnc, this.deps.env.ENCRYPTION_KEY);
    }
    // Uma renovação por vez: chamadas simultâneas esperam a mesma.
    this.refreshing ??= this.doRefresh(row.updatedAt).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(seenUpdatedAt: Date): Promise<string> {
    const { db, env } = this.deps;
    const row = await db.blingAuth.findUnique({ where: { id: 'default' } });
    if (!row) throw new BlingNotConnectedError();
    // Outro processo já renovou enquanto esperávamos.
    if (row.updatedAt.getTime() !== seenUpdatedAt.getTime() && row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return decrypt(row.accessTokenEnc, env.ENCRYPTION_KEY);
    }
    try {
      const tokens = await refreshTokens(env, decrypt(row.refreshTokenEnc, env.ENCRYPTION_KEY));
      await saveTokens(this.deps, tokens, 'refresh');
      log.info('Token do Bling renovado');
      return tokens.access_token;
    } catch (err) {
      if (err instanceof BlingApiError && !err.retryable && (err.status === 400 || err.status === 401)) {
        // refresh_token inválido/expirado (30 dias sem uso ou acesso revogado): exige reconectar.
        await db.blingAuth.deleteMany({});
        await db.alert.create({
          data: {
            level: 'CRITICAL',
            type: 'BLING_DISCONNECTED',
            message: 'A conexão com o Bling expirou ou foi revogada. Reconecte em Produtos > Conectar Bling.',
            meta: { error: err.message },
          },
        });
        log.error({ err: err.message }, 'Refresh do Bling recusado; conexão removida');
        throw new BlingNotConnectedError('A conexão com o Bling expirou. Reconecte em Produtos > Conectar Bling.');
      }
      throw err;
    }
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, query?: Record<string, QueryValue>, body?: unknown): Promise<T> {
    const url = `${this.deps.env.BLING_API_BASE_URL}${path}${buildQuery(query)}`;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      await this.throttle();
      this.calls++;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw new BlingApiError(`Sem resposta do Bling (${(err as Error).message})`, 0, 'network', true);
        await this.backoff(attempt, null, path, 'rede');
        continue;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          const info = errorInfo(await res.json().catch(() => null));
          throw new BlingApiError(info.message ?? `Bling indisponível (HTTP ${res.status})`, res.status, info.type, true);
        }
        await this.backoff(attempt, res.headers.get('retry-after'), path, String(res.status));
        continue;
      }
      if (res.status === 204) return undefined as T;
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const info = errorInfo(json);
        throw new BlingApiError(info.message ?? `Erro do Bling (HTTP ${res.status})`, res.status, info.type, false, info.fields);
      }
      return json as T;
    }
  }

  private async backoff(attempt: number, retryAfter: string | null, path: string, reason: string): Promise<void> {
    const fromHeader = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
    const exp = Math.min(30_000, this.backoffMs * 2 ** (attempt - 1));
    const wait = Math.max(fromHeader, exp + Math.floor(Math.random() * this.backoffMs * 0.25));
    log.warn({ path, attempt, wait, reason }, 'Bling: nova tentativa');
    await this.sleep(wait);
  }
}

const clients = new WeakMap<PrismaClient, BlingClient>();

/** Um cliente por processo (o limitador de chamadas precisa ser compartilhado). */
export function blingClient(deps: BlingDeps): BlingClient {
  let c = clients.get(deps.db);
  if (!c) {
    c = new BlingClient(deps);
    clients.set(deps.db, c);
  }
  return c;
}
