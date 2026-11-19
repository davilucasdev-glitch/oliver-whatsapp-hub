import type { AlertKind, PrismaClient } from '@prisma/client';
import { spDate } from '../charges/config.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { sendTemplateTo } from '../messaging/notify.js';
import { groupOf, type OrderNoticeConfig } from '../orders/config.js';
import { effectiveOrderConfig } from '../orders/situations.js';
import { getSetting, setSetting } from '../settings.js';

/**
 * Avisos internos para a equipe (documento da Ellen, "Avisos internos"):
 *  - pedido novo entrou em Separando → quem separa (Duda, Gabi);
 *  - pedido parado mais de 1 dia em Separando ou Emitir etiqueta → Oliver (uma vez por dia);
 *  - fim do dia: quantos pedidos saíram e quantos ficaram.
 * Regra: o aviso mostra só o nº do pedido e o nome da cliente.
 * Cada pessoa escolhe o que recebe em Equipe (precisa do WhatsApp dela cadastrado).
 */

const log = childLogger('equipe:avisos');

export const ALERT_KINDS = ['NOVOS_SEPARANDO', 'PARADOS', 'RESUMO_DIA', 'SISTEMA'] as const satisfies readonly AlertKind[];
export type AlertKindKey = (typeof ALERT_KINDS)[number];

export const ALERT_INFO: Record<AlertKindKey, { label: string; when: string; userFlag: 'alertNewOrders' | 'alertStuck' | 'alertDaily' | 'alertSystem'; suggested: { name: string; body: string; examples: string[] } }> = {
  NOVOS_SEPARANDO: {
    label: 'Pedido novo para separar',
    when: 'Quando um pedido entra em Separando',
    userFlag: 'alertNewOrders',
    suggested: { name: 'equipe_pedidos_separar', body: 'Pedido novo para separar: {{1}}. Bom trabalho!', examples: ['nº 8814 (Gisele)'] },
  },
  PARADOS: {
    label: 'Pedidos parados',
    when: 'Uma vez por dia, pedidos há mais de 1 dia em Separando ou Emitir etiqueta',
    userFlag: 'alertStuck',
    suggested: {
      name: 'equipe_pedidos_parados',
      body: 'Atenção: pedidos parados há mais de 1 dia em Separando ou Emitir etiqueta: {{1}}. Dá uma olhada no Kanban.',
      examples: ['nº 8800 (Gisele), nº 8807 (Ana)'],
    },
  },
  RESUMO_DIA: {
    label: 'Resumo do dia',
    when: 'No fim do dia',
    userFlag: 'alertDaily',
    suggested: {
      name: 'equipe_resumo_dia',
      body: 'Resumo de hoje na Oliver Cosméticos: {{1}} pedido(s) saíram e {{2}} ficaram em andamento ({{3}}). Até amanhã!',
      examples: ['12', '3', 'nº 8814, nº 8815, nº 8820'],
    },
  },
  SISTEMA: {
    label: 'Alerta do sistema (administradores)',
    when: 'Quando algo para: Bling desconectado, leitura de pedidos parada, número com problema na Meta',
    userFlag: 'alertSystem',
    suggested: {
      name: 'equipe_alerta_sistema',
      body: 'Atenção no Oliver Hub: {{1}}. Abra o painel para ver os detalhes (aviso automático).',
      examples: ['O Bling está desconectado: avisos de pedido pararam'],
    },
  },
};

export interface TeamAlertConfig {
  stuckHour: number;
  summaryHour: number;
  phoneNumberId: string | null;
  templates: Record<AlertKindKey, string>;
}

const KEY = 'team.alerts';

export async function getAlertConfig(db: PrismaClient): Promise<TeamAlertConfig> {
  const base: TeamAlertConfig = {
    stuckHour: 9,
    summaryHour: 18,
    phoneNumberId: null,
    templates: Object.fromEntries(ALERT_KINDS.map((k) => [k, ALERT_INFO[k].suggested.name])) as TeamAlertConfig['templates'],
  };
  const saved = await getSetting<Partial<TeamAlertConfig> | null>(db, KEY, null);
  return saved ? { ...base, ...saved, templates: { ...base.templates, ...saved.templates } } : base;
}

export async function saveAlertConfig(db: PrismaClient, cfg: TeamAlertConfig): Promise<void> {
  await setSetting(db, KEY, cfg);
}

/** Alguém da equipe quer algum aviso? (senão nem vale ler o Bling por causa disso) */
export async function teamAlertsWanted(db: PrismaClient): Promise<boolean> {
  return (await db.user.count({ where: { active: true, phone: { not: null }, OR: [{ alertNewOrders: true }, { alertStuck: true }, { alertDaily: true }] } })) > 0;
}

const NBSP_FREE = (s: string) => s.replace(/\s+/g, ' ').trim();
/** "nº 8814 (Gisele), nº 8815 (Nati)" — só número e primeiro nome; corta antes do limite da Meta. */
export function orderList(items: { numero: number; contactName: string | null }[], max = 25): string {
  const parts = items.slice(0, max).map((o) => `nº ${o.numero}${o.contactName ? ` (${NBSP_FREE(o.contactName).split(' ')[0]})` : ''}`);
  const rest = items.length - parts.length;
  return parts.join(', ') + (rest > 0 ? ` e mais ${rest}` : '');
}

/** Hora (0–23) em Brasília. */
function spHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(d));
}

async function sendToUsers(deps: Deps, cfg: TeamAlertConfig, kind: AlertKindKey, key: (userId: string) => string, body: string[]) {
  const users = await deps.db.user.findMany({ where: { active: true, phone: { not: null }, [ALERT_INFO[kind].userFlag]: true } });
  let sent = 0;
  for (const u of users) {
    const k = key(u.id);
    if (await deps.db.teamAlert.findUnique({ where: { key: k } })) continue;
    const text = ALERT_INFO[kind].suggested.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => body[Number(n) - 1] ?? '');
    try {
      await sendTemplateTo(deps, { phone: u.phone!, name: `${u.name || u.email.split('@')[0]} (equipe)`, templateName: cfg.templates[kind], body, numberId: cfg.phoneNumberId });
      await deps.db.teamAlert.create({ data: { key: k, kind, userId: u.id, status: 'SENT', text } });
      sent++;
    } catch (err) {
      await deps.db.teamAlert.create({ data: { key: k, kind, userId: u.id, status: 'FAILED', text, reason: (err as Error).message.slice(0, 300) } });
      log.warn({ aviso: kind, para: u.email, err: (err as Error).message }, 'Aviso para a equipe não enviado');
    }
  }
  return sent;
}

function groupIds(cfg: OrderNoticeConfig, groups: string[]): number[] {
  return groups.flatMap((g) => cfg.situations[g as keyof OrderNoticeConfig['situations']] ?? []);
}

/**
 * Roda a cada leitura de pedidos. `newSeparando` = pedidos que acabaram de entrar em Separando
 * nesta rodada (a lista vem do motor de avisos de pedido).
 */
export async function runTeamAlerts(deps: Deps, opts: { now?: Date; newSeparando?: { numero: number; contactName: string | null; blingOrderId: string }[] } = {}) {
  const now = opts.now ?? new Date();
  if (!(await teamAlertsWanted(deps.db))) return { sent: 0 };
  const cfg = await getAlertConfig(deps.db);
  const orderCfg = await effectiveOrderConfig(deps);
  const today = spDate(now);
  let sent = 0;

  if (opts.newSeparando?.length) {
    const ids = opts.newSeparando.map((o) => o.blingOrderId).sort().join(',');
    sent += await sendToUsers(deps, cfg, 'NOVOS_SEPARANDO', (u) => `NOVOS:${ids}:${u}`, [orderList(opts.newSeparando)]);
  }

  const working = groupIds(orderCfg, ['SEPARANDO', 'ETIQUETA']);
  if (spHour(now) >= cfg.stuckHour && working.length) {
    const stuck = await deps.db.orderState.findMany({
      where: { situacaoId: { in: working }, situacaoSince: { lt: new Date(now.getTime() - 24 * 3600_000) } },
      orderBy: { situacaoSince: 'asc' },
    });
    if (stuck.length) sent += await sendToUsers(deps, cfg, 'PARADOS', (u) => `PARADOS:${today}:${u}`, [orderList(stuck)]);
  }

  if (spHour(now) >= cfg.summaryHour) {
    const dayStart = new Date(`${today}T03:00:00Z`); // 00:00 em Brasília
    const outIds = groupIds(orderCfg, ['ENVIADO', 'ATENDIDO']);
    const [out, pending] = await Promise.all([
      deps.db.orderState.count({ where: { situacaoId: { in: outIds }, situacaoSince: { gte: dayStart } } }),
      deps.db.orderState.findMany({ where: { situacaoId: { in: working } }, orderBy: { numero: 'asc' } }),
    ]);
    const list = pending.length ? pending.map((o) => `nº ${o.numero}`).slice(0, 40).join(', ') + (pending.length > 40 ? ` e mais ${pending.length - 40}` : '') : 'nenhum';
    sent += await sendToUsers(deps, cfg, 'RESUMO_DIA', (u) => `RESUMO:${today}:${u}`, [String(out), String(pending.length), list]);
  }
  return { sent };
}

export { groupOf };
