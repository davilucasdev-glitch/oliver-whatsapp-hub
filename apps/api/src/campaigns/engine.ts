import type { Campaign, Contact, PhoneNumber, Template } from '@prisma/client';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { sendTemplateMessage } from '../messaging/outbound.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { classifySendError, type ClassifiedError } from './errors.js';
import {
  dailyCap,
  FAILURE_PAUSE_MIN_ATTEMPTS,
  FAILURE_PAUSE_RATE,
  isWithinWindow,
  nextSlot,
  nextWindowStart,
  sendIntervalMs,
  skipReasonFor,
} from './rules.js';
import { buildCampaignMessage, getMinDaysBetween, launchCampaign, loadProducts, numberBlockReason, variablesOf } from './service.js';
import type { ProductLookup } from './variables.js';

/**
 * Motor de campanhas. Roda a cada CAMPAIGN_TICK_MS (fila "campaign"):
 *  1. inicia as agendadas que chegaram na hora;
 *  2. para cada número com campanha rodando, confere qualidade/pausa, template, janela e limite diário;
 *  3. envia no ritmo do número (sendRatePerMinute), reservando cada "vaga" no banco — seguro mesmo
 *     com API e worker rodando juntos;
 *  4. reage aos erros da Meta (desacelera, pausa o número, pausa a campanha ou marca o contato).
 */

const log = childLogger('campaigns:engine');

type RunningCampaign = Campaign & { template: Template };

export interface TickOptions {
  /** limite de envios por número numa rodada (a próxima rodada continua) */
  maxPerNumber?: number;
  /** tolerância de atraso compensada no ritmo (normalmente = intervalo da rodada) */
  catchUpMs?: number;
}

export interface TickResult {
  started: number;
  sent: number;
  failed: number;
  completed: number;
}

const THROTTLE_BACKOFF_MS = 60_000;
const TRANSIENT_BACKOFF_MS = 30_000;
const STUCK_SENDING_MS = 5 * 60_000;

function fmtWhen(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

async function setWaiting(deps: Deps, list: Pick<Campaign, 'id' | 'waitingReason'>[], reason: string | null) {
  const ids = list.filter((c) => c.waitingReason !== reason).map((c) => c.id);
  if (ids.length) await deps.db.campaign.updateMany({ where: { id: { in: ids }, status: 'RUNNING' }, data: { waitingReason: reason } });
  for (const c of list) c.waitingReason = reason;
}

async function alert(deps: Deps, level: 'INFO' | 'WARNING' | 'CRITICAL', type: string, message: string, phoneNumberId: string, campaignId?: string) {
  await deps.db.alert.create({ data: { level, type, message, phoneNumberId, meta: campaignId ? { campaignId } : undefined } });
}

/** Pausa uma campanha automaticamente (com alerta no painel). */
export async function autoPauseCampaign(deps: Deps, c: Pick<Campaign, 'id' | 'name' | 'phoneNumberId'>, reason: string) {
  const res = await deps.db.campaign.updateMany({
    where: { id: c.id, status: { in: ['RUNNING', 'SCHEDULED'] } },
    data: { status: 'PAUSED', pausedReason: reason, pausedAt: new Date(), waitingReason: null },
  });
  if (res.count) {
    await alert(deps, 'WARNING', 'CAMPAIGN_PAUSED', `Campanha "${c.name}" pausada: ${reason}`, c.phoneNumberId, c.id);
    log.warn({ campaign: c.name, reason }, 'Campanha pausada automaticamente');
  }
}

/** Problema no número: pausa todas as campanhas dele e trava novas até você liberar em Números. */
async function pauseNumber(deps: Deps, number: PhoneNumber, reason: string) {
  await deps.db.phoneNumber.update({ where: { id: number.id }, data: { campaignsPaused: true } });
  const res = await deps.db.campaign.updateMany({
    where: { phoneNumberId: number.id, status: { in: ['RUNNING', 'SCHEDULED'] } },
    data: { status: 'PAUSED', pausedReason: reason, pausedAt: new Date(), waitingReason: null },
  });
  await alert(deps, 'CRITICAL', 'CAMPAIGN_PAUSED', `${reason}. Campanhas do número ${number.displayName} pausadas (${res.count}).`, number.id);
  log.error({ number: number.displayName, reason }, 'Campanhas do número pausadas');
}

/** Reserva a próxima "vaga" de envio do número (atualização condicional = sem corrida entre processos). */
async function claimSlot(deps: Deps, numberId: string, now: Date, intervalMs: number, catchUpMs: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const n = await deps.db.phoneNumber.findUniqueOrThrow({ where: { id: numberId }, select: { campaignNextSendAt: true } });
    const next = nextSlot(n.campaignNextSendAt, now, intervalMs, catchUpMs);
    if (!next) return false;
    const res = await deps.db.phoneNumber.updateMany({ where: { id: numberId, campaignNextSendAt: n.campaignNextSendAt }, data: { campaignNextSendAt: next } });
    if (res.count) return true;
  }
  return false;
}

async function backoffNumber(deps: Deps, numberId: string, now: Date, ms: number) {
  await deps.db.phoneNumber.update({ where: { id: numberId }, data: { campaignNextSendAt: new Date(now.getTime() + ms) } });
}

/** Próximo destinatário apto; quem deixou de poder receber (opt-out, frequência…) é marcado e pulado. */
async function nextRecipient(deps: Deps, campaignId: string, now: Date, minDays: number) {
  for (let i = 0; i < 200; i++) {
    const r = await deps.db.campaignRecipient.findFirst({ where: { campaignId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, include: { contact: true } });
    if (!r) return null;
    const skip = skipReasonFor(r.contact, now, minDays);
    if (!skip) return r;
    await deps.db.campaignRecipient.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: skip === 'opt-out' ? 'OPTED_OUT' : 'SKIPPED', skipReason: skip } });
  }
  return null;
}

async function maybeComplete(deps: Deps, c: RunningCampaign, now: Date): Promise<boolean> {
  const left = await deps.db.campaignRecipient.count({ where: { campaignId: c.id, status: { in: ['PENDING', 'SENDING'] } } });
  if (left) return false;
  const res = await deps.db.campaign.updateMany({ where: { id: c.id, status: 'RUNNING' }, data: { status: 'COMPLETED', finishedAt: now, waitingReason: null } });
  if (res.count) {
    const sent = await deps.db.campaignRecipient.count({ where: { campaignId: c.id, sentAt: { not: null } } });
    await alert(deps, 'INFO', 'CAMPAIGN_COMPLETED', `Campanha "${c.name}" concluída: ${sent} mensagem(ns) enviada(s).`, c.phoneNumberId, c.id);
    log.info({ campaign: c.name, sent }, 'Campanha concluída');
  }
  return res.count > 0;
}

/** Muitas falhas (lista ruim, números inexistentes) derrubam a qualidade: pausa antes. */
async function checkFailureRate(deps: Deps, c: RunningCampaign): Promise<boolean> {
  const [failed, attempted] = await Promise.all([
    deps.db.campaignRecipient.count({ where: { campaignId: c.id, status: 'FAILED' } }),
    deps.db.campaignRecipient.count({ where: { campaignId: c.id, OR: [{ sentAt: { not: null } }, { status: 'FAILED' }] } }),
  ]);
  if (attempted >= FAILURE_PAUSE_MIN_ATTEMPTS && failed / attempted > FAILURE_PAUSE_RATE) {
    await autoPauseCampaign(
      deps,
      c,
      `${Math.round((failed / attempted) * 100)}% dos envios falharam (${failed} de ${attempted}). Confira os motivos no relatório antes de retomar`,
    );
    return true;
  }
  return false;
}

type SendOutcome = 'sent' | 'failed' | 'stop-number' | 'stop-campaign';

async function markOptOutFromMeta(deps: Deps, contact: Contact, e: ClassifiedError) {
  if (contact.optOut) return;
  await deps.db.$transaction([
    deps.db.contact.update({ where: { id: contact.id }, data: { optOut: true, optOutAt: new Date() } }),
    deps.db.consentLog.create({ data: { contactId: contact.id, action: 'OPT_OUT', source: `meta:${e.code}`, detail: e.message } }),
  ]);
}

async function sendOne(
  deps: Deps,
  c: RunningCampaign,
  number: PhoneNumber,
  recipient: { id: string; contact: Contact },
  products: ProductLookup,
  now: Date,
): Promise<SendOutcome> {
  const { contact } = recipient;
  try {
    const msg = buildCampaignMessage(c.template.components as unknown as TemplateComponentDef[], c, contact, products);
    const conv = await deps.db.conversation.upsert({
      where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: number.id } },
      create: { contactId: contact.id, phoneNumberId: number.id },
      update: {},
    });
    const sent = await sendTemplateMessage(deps, {
      conversationId: conv.id,
      sentBy: 'CAMPAIGN',
      campaignId: c.id,
      name: c.template.name,
      language: c.template.language,
      ...msg,
    });
    await deps.db.$transaction([
      deps.db.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: 'SENT', waMessageId: sent.waMessageId, messageId: sent.id, sentAt: now, errorCode: null, errorMessage: null },
      }),
      deps.db.contact.update({ where: { id: contact.id }, data: { lastCampaignAt: now } }),
    ]);
    return 'sent';
  } catch (err) {
    const e = classifySendError(err);
    const backToQueue = () => deps.db.campaignRecipient.update({ where: { id: recipient.id }, data: { status: 'PENDING' } });
    log.warn({ campaign: c.name, kind: e.kind, code: e.code, err: e.message }, 'Envio de campanha recusado');
    switch (e.kind) {
      case 'throttle':
        await backToQueue();
        await backoffNumber(deps, number.id, now, THROTTLE_BACKOFF_MS);
        await setWaiting(deps, [c], 'A Meta pediu para diminuir o ritmo. Retomando em 1 minuto.');
        return 'stop-number';
      case 'transient':
        await backToQueue();
        await backoffNumber(deps, number.id, now, TRANSIENT_BACKOFF_MS);
        await deps.db.campaign.update({ where: { id: c.id }, data: { lastError: `${e.message} (${e.code})` } });
        await setWaiting(deps, [c], `${e.message}. Nova tentativa em 30 segundos.`);
        return 'stop-number';
      case 'number':
        await backToQueue();
        await pauseNumber(deps, number, `${e.message} (erro ${e.code})`);
        return 'stop-number';
      case 'template':
        await backToQueue();
        await autoPauseCampaign(deps, c, `${e.message} (erro ${e.code})`);
        return 'stop-campaign';
      case 'recipient':
        await deps.db.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: 'FAILED', errorCode: e.code, errorMessage: e.message, failedAt: now },
        });
        if (e.optOut) await markOptOutFromMeta(deps, contact, e);
        return (await checkFailureRate(deps, c)) ? 'stop-campaign' : 'failed';
    }
  }
}

async function runNumber(deps: Deps, number: PhoneNumber, campaigns: RunningCampaign[], now: Date, opts: Required<TickOptions>, result: TickResult) {
  const block = numberBlockReason(number);
  if (block) {
    for (const c of campaigns) await autoPauseCampaign(deps, c, block);
    return;
  }

  const active: RunningCampaign[] = [];
  for (const c of campaigns) {
    if (c.template.status !== 'APPROVED') {
      await autoPauseCampaign(deps, c, `O template ${c.template.name} não está mais aprovado pela Meta (${c.template.status})`);
    } else if (!isWithinWindow(now, c.timezone, c.windowStartHour, c.windowEndHour)) {
      const back = fmtWhen(nextWindowStart(now, c.timezone, c.windowStartHour), c.timezone);
      await setWaiting(deps, [c], `Fora da janela de envio (${c.windowStartHour}h às ${c.windowEndHour}h). Continua ${back}.`);
    } else if (!(await checkFailureRate(deps, c))) {
      active.push(c);
    }
  }
  if (!active.length) return;

  const cap = dailyCap(number);
  let used = await deps.db.message.count({
    where: { phoneNumberId: number.id, direction: 'OUTBOUND', type: 'template', status: { not: 'FAILED' }, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
  });
  if (used >= cap) {
    await setWaiting(deps, active, `Limite diário do número atingido (${used} de ${cap} conversas em 24h, 90% do tier). Continua quando liberar.`);
    return;
  }

  const minDays = await getMinDaysBetween(deps);
  const interval = sendIntervalMs(number.sendRatePerMinute);
  const products = new Map<string, ProductLookup>();
  for (const c of active) products.set(c.id, await loadProducts(deps, variablesOf(c)));

  // revezamento entre rodadas: quem enviou há mais tempo vai primeiro
  const last = await deps.db.campaignRecipient.groupBy({ by: ['campaignId'], where: { campaignId: { in: active.map((c) => c.id) } }, _max: { sentAt: true } });
  const lastOf = (id: string) => last.find((l) => l.campaignId === id)?._max.sentAt?.getTime() ?? 0;
  const queue = [...active].sort((a, b) => lastOf(a.id) - lastOf(b.id));
  let sentHere = 0;
  while (queue.length && sentHere < opts.maxPerNumber && used < cap) {
    const c = queue[0]!;
    const recipient = await nextRecipient(deps, c.id, now, minDays);
    if (!recipient) {
      queue.shift();
      if (await maybeComplete(deps, c, now)) result.completed++;
      continue;
    }
    if (!(await claimSlot(deps, number.id, now, interval, opts.catchUpMs))) break; // ainda não é hora: próxima rodada
    const claimed = await deps.db.campaignRecipient.updateMany({ where: { id: recipient.id, status: 'PENDING' }, data: { status: 'SENDING' } });
    if (!claimed.count) continue;
    if (c.waitingReason) await setWaiting(deps, [c], null);

    const outcome = await sendOne(deps, c, number, recipient, products.get(c.id)!, now);
    sentHere++;
    if (outcome === 'sent') {
      result.sent++;
      used++;
    } else if (outcome === 'failed') {
      result.failed++;
    } else if (outcome === 'stop-number') {
      return;
    } else {
      queue.shift();
      continue;
    }
    // várias campanhas no mesmo número: revezam (o ritmo é do número, não da campanha)
    queue.push(queue.shift()!);
  }
  if (used >= cap) await setWaiting(deps, queue, `Limite diário do número atingido (${used} de ${cap} conversas em 24h). Continua quando liberar.`);
}

export async function runCampaignTick(deps: Deps, now = new Date(), options: TickOptions = {}): Promise<TickResult> {
  const opts: Required<TickOptions> = { maxPerNumber: options.maxPerNumber ?? 60, catchUpMs: options.catchUpMs ?? deps.env.CAMPAIGN_TICK_MS };
  const result: TickResult = { started: 0, sent: 0, failed: 0, completed: 0 };

  // 1. agendadas que chegaram na hora
  const due = await deps.db.campaign.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, select: { id: true, name: true } });
  for (const c of due) {
    if (await launchCampaign(deps, c.id, now)) {
      result.started++;
      log.info({ campaign: c.name }, 'Campanha agendada iniciada');
    }
  }

  // 2. envio interrompido no meio (processo caiu): não reenvia para não duplicar mensagem
  await deps.db.campaignRecipient.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) } },
    data: { status: 'FAILED', errorCode: 'INTERROMPIDO', errorMessage: 'Envio interrompido (não reenviado para evitar mensagem duplicada)', failedAt: now },
  });

  // 3. envio por número
  const running = await deps.db.campaign.findMany({
    where: { status: 'RUNNING', audienceBuiltAt: { not: null } },
    include: { template: true },
    orderBy: { startedAt: 'asc' },
  });
  const byNumber = new Map<string, RunningCampaign[]>();
  for (const c of running) byNumber.set(c.phoneNumberId, [...(byNumber.get(c.phoneNumberId) ?? []), c]);
  for (const [numberId, list] of byNumber) {
    const number = await deps.db.phoneNumber.findUnique({ where: { id: numberId } });
    if (!number) continue;
    try {
      await runNumber(deps, number, list, now, opts, result);
    } catch (err) {
      log.error({ number: number.displayName, err: (err as Error).message }, 'Erro na rodada de campanhas');
    }
  }
  return result;
}
