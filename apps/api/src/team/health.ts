import type { Deps } from '../deps.js';
import { getChargeSyncState } from '../charges/config.js';
import { childLogger } from '../lib/logger.js';
import { sendTemplateTo } from '../messaging/notify.js';
import { getOrderConfig, getPollState } from '../orders/config.js';
import { QUEUES } from '../queue/index.js';
import { ALERT_INFO, getAlertConfig, teamAlertsWanted } from './alerts.js';
import { runRetention } from './retention.js';

/**
 * Saúde do hub em produção: a cada 5 min confere se as partes automáticas estão rodando e manda
 * os alertas GRAVES para o WhatsApp dos administradores (quem tem WhatsApp em Equipe e não
 * desligou "Alertas do sistema"). Os alertas também aparecem na Visão geral do painel.
 * Queda total do servidor não tem como avisar daqui: para isso, um monitor externo no /health.
 */

const log = childLogger('saude');
let lastRetention = '';
const EVERY_MS = 5 * 60_000;
const DEDUPE_MS = 6 * 3600_000; // o mesmo problema não vira alerta novo antes de 6 h

async function raise(deps: Deps, type: string, message: string, level: 'CRITICAL' | 'WARNING' = 'CRITICAL', now = new Date()) {
  const recent = await deps.db.alert.findFirst({ where: { type, createdAt: { gte: new Date(now.getTime() - DEDUPE_MS) } } });
  if (recent) return false;
  await deps.db.alert.create({ data: { level, type, message } });
  log.warn({ type }, message);
  return true;
}

/** Confere as rotinas automáticas e cria alertas quando algo parou. */
export async function runHealthChecks(deps: Deps, now = new Date()) {
  let created = 0;
  const bling = await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } });
  const orderCfg = await getOrderConfig(deps.db);
  const ordersNeeded = orderCfg.enabled || (await teamAlertsWanted(deps.db));

  if (ordersNeeded && !bling) {
    created += Number(await raise(deps, 'BLING_DISCONNECTED', 'O Bling está desconectado: avisos de pedido e da equipe pararam. Reconecte em Produtos > Conectar Bling.', 'CRITICAL', now));
  }
  if (ordersNeeded && bling) {
    const st = await getPollState(deps.db);
    const minutes = st.lastRunAt ? Math.round((now.getTime() - new Date(st.lastRunAt).getTime()) / 60_000) : null;
    if (minutes !== null && minutes > 15) {
      created += Number(await raise(deps, 'ORDERS_STALE', `A leitura de pedidos do Bling está parada há ${minutes} min (avisos de pedido e da equipe não estão saindo)`, 'CRITICAL', now));
    } else if (st.lastError) {
      created += Number(await raise(deps, 'ORDERS_ERROR', `Leitura de pedidos com erro: ${st.lastError}`.slice(0, 300), 'CRITICAL', now));
    }
  }
  if (bling) {
    const cs = await getChargeSyncState(deps.db);
    if (cs.lastError) created += Number(await raise(deps, 'CHARGES_ERROR', `Contas a receber não atualizam: ${cs.lastError}`.slice(0, 300), 'WARNING', now));
  }
  // avisos para o site: as 5 últimas entregas da última hora falharam
  const hooks = await deps.db.siteWebhookLog.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 3600_000) } }, orderBy: { createdAt: 'desc' }, take: 5 });
  if (hooks.length === 5 && hooks.every((h) => !h.ok)) {
    created += Number(await raise(deps, 'SITE_WEBHOOK_FAILING', `O site não está recebendo os avisos do hub (${hooks[0]!.error ?? 'sem resposta'})`, 'WARNING', now));
  }
  // número sem conexão com a Meta
  const down = await deps.db.phoneNumber.findMany({ where: { isActive: true, status: { not: 'CONNECTED' } }, select: { displayName: true, status: true } });
  for (const n of down) {
    created += Number(await raise(deps, `NUMBER_${n.displayName}`, `O número ${n.displayName} está com status ${n.status} na Meta`, 'CRITICAL', now));
  }
  return { created };
}

/** Manda os alertas graves ainda não avisados para os administradores (uma mensagem por rodada). */
export async function notifyAdmins(deps: Deps, now = new Date()) {
  const pending = await deps.db.alert.findMany({
    where: { notifiedAt: null, level: 'CRITICAL', createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (!pending.length) return { sent: 0 };
  const admins = await deps.db.user.findMany({ where: { active: true, role: 'ADMIN', alertSystem: true, phone: { not: null } } });
  const cfg = await getAlertConfig(deps.db);
  const text = pending.map((a) => a.message.replace(/\s+/g, ' ').trim()).join(' · ').slice(0, 900);
  let sent = 0;
  for (const u of admins) {
    const key = `SISTEMA:${pending.map((a) => a.id).join(',')}:${u.id}`;
    if (await deps.db.teamAlert.findUnique({ where: { key } })) continue;
    try {
      await sendTemplateTo(deps, { phone: u.phone!, name: `${u.name || u.email.split('@')[0]} (equipe)`, templateName: cfg.templates.SISTEMA, body: [text], numberId: cfg.phoneNumberId });
      await deps.db.teamAlert.create({ data: { key, kind: 'SISTEMA', userId: u.id, status: 'SENT', text } });
      sent++;
    } catch (err) {
      await deps.db.teamAlert.create({ data: { key, kind: 'SISTEMA', userId: u.id, status: 'FAILED', text, reason: (err as Error).message.slice(0, 300) } });
      log.warn({ err: (err as Error).message }, 'Alerta do sistema não foi para o WhatsApp');
    }
  }
  // marca como avisado mesmo sem ninguém para receber: aparece no painel e não acumula
  await deps.db.alert.updateMany({ where: { id: { in: pending.map((a) => a.id) } }, data: { notifiedAt: now } });
  return { sent };
}

export function registerHealthWorker(deps: Deps): void {
  deps.bus.process(
    QUEUES.health,
    async () => {
      await runHealthChecks(deps).catch((err: Error) => log.warn({ err: err.message }, 'Verificação de saúde falhou'));
      await notifyAdmins(deps).catch((err: Error) => log.warn({ err: err.message }, 'Aviso aos administradores falhou'));
      // uma vez por dia: apaga registros técnicos antigos
      const today = new Date().toISOString().slice(0, 10);
      if (lastRetention !== today) {
        lastRetention = today;
        await runRetention(deps).catch((err: Error) => log.warn({ err: err.message }, 'Limpeza de registros antigos falhou'));
      }
    },
    { concurrency: 1 },
  );
}

export function startHealthScheduler(deps: Deps): () => void {
  const tick = () => {
    const slot = Math.floor(Date.now() / EVERY_MS);
    deps.bus.add(QUEUES.health, 'check', {}, { jobId: `health-${slot}`, attempts: 1, removeOnComplete: true }).catch(() => undefined);
  };
  const first = setTimeout(tick, 90_000);
  const timer = setInterval(tick, EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export { ALERT_INFO };
