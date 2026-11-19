import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';

/**
 * Guarda dos registros (LGPD + espaço em disco). Roda uma vez por dia.
 *
 * GUARDA (nunca apaga aqui): conversas e mensagens, avisos de pedido, cobranças, relacionamento,
 * fornecedores, envios do site, consentimentos (opt-in/opt-out). O documento pede o registro de cada
 * envio "guardado por 12 meses" — fica guardado enquanto o hub existir.
 *
 * APAGA registros técnicos que só servem para conferir problemas recentes:
 *  - eventos crus do webhook da Meta (já viraram mensagens/status)  → 90 dias
 *  - entregas dos avisos para o site                                  → 90 dias
 *  - registro técnico do bot de IA e testes do simulador             → 180 dias
 *  - alertas lidos e avisos internos para a equipe                   → 365 dias
 *  - sessões vencidas e desafios de login                             → na hora
 *  - arte de campanha do painel                                       → 365 dias
 */

const log = childLogger('retencao');
const day = 86_400_000;

export async function runRetention(deps: Deps, now = new Date()) {
  const before = (days: number) => new Date(now.getTime() - days * day);
  const r = await Promise.all([
    deps.db.webhookEvent.deleteMany({ where: { createdAt: { lt: before(90) } } }),
    deps.db.siteWebhookLog.deleteMany({ where: { createdAt: { lt: before(90) } } }),
    deps.db.botLog.deleteMany({ where: { createdAt: { lt: before(180) } } }),
    deps.db.botSimSession.deleteMany({ where: { updatedAt: { lt: before(30) } } }),
    deps.db.alert.deleteMany({ where: { readAt: { not: null }, createdAt: { lt: before(365) } } }),
    deps.db.teamAlert.deleteMany({ where: { createdAt: { lt: before(365) } } }),
    deps.db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    deps.db.loginChallenge.deleteMany({ where: { expiresAt: { lt: now } } }),
    deps.db.campaignArt.deleteMany({ where: { createdAt: { lt: before(365) } } }),
  ]);
  const removed = r.reduce((a, x) => a + x.count, 0);
  if (removed) log.info({ apagados: removed }, 'Registros técnicos antigos apagados');
  return { removed };
}
