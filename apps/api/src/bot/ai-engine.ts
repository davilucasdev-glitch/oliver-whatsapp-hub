import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { QUEUES } from '../queue/index.js';
import { getSetting, SETTINGS } from '../settings.js';
import { FALLBACK_ERROR_MESSAGE, runBotTurn } from './engine.js';
import { conversationIO } from './io.js';
import { anthropicLlm, BotNotConfiguredError, type LlmClient } from './llm.js';
import type { ReplyEngine } from './reply-engine.js';

const log = childLogger('bot:ai');

export interface BotJob {
  conversationId: string;
  waMessageId: string;
}

/**
 * BOT_MODE=ai: a mensagem recebida vira um job na fila "bot" com uma pequena espera (BOT_DEBOUNCE_MS).
 * Se o cliente mandar várias mensagens seguidas, só a última gera resposta, e ela considera todas.
 */
export const aiReplyEngine: ReplyEngine = {
  name: 'ai',
  async reply(deps, ctx) {
    await deps.bus.add<BotJob>(
      QUEUES.bot,
      'reply',
      { conversationId: ctx.conversationId, waMessageId: ctx.inboundWaMessageId },
      { jobId: `reply-${ctx.inboundWaMessageId}`, delayMs: deps.env.BOT_DEBOUNCE_MS, attempts: 1 },
    );
  },
};

const running = new Map<string, Promise<void>>();

/** Uma resposta por conversa de cada vez (neste processo). */
function serial(conversationId: string, fn: () => Promise<void>): Promise<void> {
  const prev = running.get(conversationId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(conversationId, next);
  return next.finally(() => {
    if (running.get(conversationId) === next) running.delete(conversationId);
  });
}

export const getLlm = (deps: Deps): Promise<LlmClient> => (deps.llmFactory ? deps.llmFactory(deps) : anthropicLlm(deps.db, deps.env));

export function registerBotWorker(deps: Deps): void {
  deps.bus.process<BotJob>(
    QUEUES.bot,
    (job) =>
      serial(job.conversationId, async () => {
        const { db } = deps;
        const conv = await db.conversation.findUnique({ where: { id: job.conversationId }, include: { phoneNumber: true } });
        if (!conv || conv.handler !== 'BOT') return;
        const botGlobal = await getSetting<boolean>(db, SETTINGS.botEnabled, true);
        if (!botGlobal || !conv.phoneNumber.botEnabled || conv.phoneNumber.role === 'CAMPAIGNS') return;

        const trigger = await db.message.findUnique({ where: { waMessageId: job.waMessageId } });
        if (!trigger) return;
        // Chegou mensagem mais nova do cliente: o job dela responde por todas.
        const newer = await db.message.findFirst({
          where: { conversationId: conv.id, direction: 'INBOUND', createdAt: { gt: trigger.createdAt }, type: { not: 'reaction' } },
          select: { id: true },
        });
        if (newer) return;
        // Já respondemos esta mensagem (job repetido) ou um atendente respondeu depois dela.
        const [botDone, humanReplied] = await Promise.all([
          db.botLog.findFirst({ where: { inboundMessageId: trigger.id }, select: { id: true } }),
          db.message.findFirst({
            where: { conversationId: conv.id, direction: 'OUTBOUND', sentBy: 'HUMAN', createdAt: { gt: trigger.createdAt } },
            select: { id: true },
          }),
        ]);
        if (botDone || humanReplied) return;

        let llm: LlmClient;
        try {
          llm = await getLlm(deps);
        } catch (err) {
          if (err instanceof BotNotConfiguredError) {
            log.error(err.message);
            const recent = await db.alert.findFirst({ where: { type: 'BOT_NOT_CONFIGURED', readAt: null } });
            if (!recent) await db.alert.create({ data: { level: 'CRITICAL', type: 'BOT_NOT_CONFIGURED', message: err.message } });
            // Melhor um atendente do que o cliente sem resposta.
            const io = conversationIO(deps, conv.id, trigger.id);
            await io.handoff('bot sem chave da Anthropic configurada');
            await io.sendText(FALLBACK_ERROR_MESSAGE).catch(() => undefined);
            return;
          }
          throw err;
        }
        const r = await runBotTurn(deps, conversationIO(deps, conv.id, trigger.id), llm);
        log.info(
          { conversationId: conv.id, tools: r.tools.map((t) => t.name), handoff: r.handoff, tokens: r.usage, error: r.error },
          'Bot respondeu',
        );
        if (r.error && r.handoff) {
          await db.alert.create({
            data: { level: 'CRITICAL', type: 'BOT_ERROR', message: `O bot falhou e passou a conversa para a equipe: ${r.error.slice(0, 200)}`, meta: { conversationId: conv.id } },
          });
        }
      }),
    { concurrency: 4 },
  );
}
