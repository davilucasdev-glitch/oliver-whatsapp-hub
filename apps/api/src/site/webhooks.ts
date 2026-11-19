import { createHmac } from 'node:crypto';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { getSiteConfig, webhookSecret, type SiteEvent } from './config.js';

/**
 * Avisos do hub para o site: POST na URL configurada com JSON
 *   { event, at, data }
 * e o cabeçalho X-Oliver-Signature: sha256=<HMAC-SHA256 do corpo com o segredo>.
 * Vai pela fila com 5 tentativas (o site fora do ar não perde o aviso na hora).
 */

const log = childLogger('site:avisos');

export interface SiteWebhookJob {
  event: SiteEvent;
  at: string;
  data: Record<string, unknown>;
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Enfileira o aviso (não faz nada se o site não tiver URL ou não quiser este evento). */
export async function emitSiteEvent(deps: Deps, event: SiteEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const cfg = await getSiteConfig(deps.db);
    if (!cfg.webhookUrl || !cfg.webhookSecretEnc || !cfg.events.includes(event)) return;
    await deps.bus.add<SiteWebhookJob>(QUEUES.site, 'deliver', { event, at: new Date().toISOString(), data }, { attempts: 5, backoffMs: 10_000, removeOnComplete: true });
  } catch (err) {
    log.warn({ event, err: (err as Error).message }, 'Não foi possível enfileirar o aviso para o site');
  }
}

export async function deliverSiteEvent(deps: Deps, job: SiteWebhookJob, attempt = 1): Promise<{ ok: boolean; status?: number; error?: string }> {
  const cfg = await getSiteConfig(deps.db);
  const secret = webhookSecret(cfg, deps.env.ENCRYPTION_KEY);
  if (!cfg.webhookUrl || !secret) return { ok: false, error: 'URL ou segredo não configurados' };
  const body = JSON.stringify(job);
  let result: { ok: boolean; status?: number; error?: string };
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Oliver-Signature': signBody(body, secret), 'X-Oliver-Event': job.event, 'User-Agent': 'OliverHub/1.0' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    result = res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `O site respondeu HTTP ${res.status}` };
  } catch (err) {
    result = { ok: false, error: `Sem resposta do site: ${(err as Error).message}`.slice(0, 300) };
  }
  await deps.db.siteWebhookLog.create({ data: { event: job.event, ok: result.ok, httpStatus: result.status ?? null, error: result.error ?? null, attempt } });
  return result;
}

export function registerSiteWorker(deps: Deps): void {
  deps.bus.process<SiteWebhookJob>(
    QUEUES.site,
    async (job) => {
      const r = await deliverSiteEvent(deps, job);
      // erro faz a fila tentar de novo (backoff); 4xx do site (exceto 429) não adianta repetir
      if (!r.ok && !(r.status && r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(r.error ?? 'falha');
    },
    { concurrency: 2 },
  );
}
