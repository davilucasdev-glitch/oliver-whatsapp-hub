import type Anthropic from '@anthropic-ai/sdk';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { getSetting, SETTINGS } from '../settings.js';
import { describeHours, isOpenAt, nextOpening, parseBusinessHours } from './hours.js';
import type { BotIO } from './io.js';
import { SUMMARY_BATCH } from './io.js';
import { getKnowledge } from './knowledge.js';
import type { LlmClient } from './llm.js';
import { buildDynamicContext, buildHistoryMessages, buildStaticSystemPrompt, buildSummaryPrompt } from './prompt.js';
import { BOT_TOOLS, runTool, type ToolContext, type ToolOutcome } from './tools.js';

const log = childLogger('bot');

export const MAX_TOOL_ROUNDS = 6;
export const BOT_CONFIG_KEY = 'bot.config';

export interface BotConfig {
  /** tentativas seguidas sem resolver antes de transferir (0 = desliga a regra) */
  maxFailedAttempts: number;
}
export const DEFAULT_BOT_CONFIG: BotConfig = { maxFailedAttempts: 2 };

export async function getBotConfig(deps: Pick<Deps, 'db'>): Promise<BotConfig> {
  return { ...DEFAULT_BOT_CONFIG, ...(await getSetting<Partial<BotConfig>>(deps.db, BOT_CONFIG_KEY, {})) };
}

export const FALLBACK_ERROR_MESSAGE = 'Desculpe, tive um probleminha aqui 😕 Já chamei um atendente da equipe para continuar com você.';
export const FAILED_ATTEMPTS_MESSAGE = 'Vou chamar um atendente da equipe para te ajudar melhor, tá? 💜';
export const DEFAULT_HANDOFF_MESSAGE = 'Certo! Vou passar sua conversa para um atendente da equipe, que continua com você por aqui. 💜';

export interface TurnOptions {
  now?: Date;
  /** simulador: força "fora do horário" */
  forceClosed?: boolean;
}

export interface TurnResult {
  reply: string | null;
  handoff: boolean;
  tools: { name: string; input: unknown; ok: boolean; outcome: ToolOutcome; ms: number }[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  iterations: number;
  stopReason: string | null;
  error: string | null;
}

const textOf = (content: Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/** Remove marcas que não devem chegar ao cliente e corta no limite do WhatsApp. */
export function cleanReply(text: string): string {
  return text
    .replace(/\[DEFINIR[^\]]*\]/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/**
 * Uma "vez" do bot: monta o contexto, conversa com o Claude (com ferramentas) e responde.
 * O histórico é remontado a cada mensagem a partir do banco (só texto); os blocos de raciocínio
 * (thinking) só vão e voltam dentro desta resposta, sem alteração, como a API exige.
 */
export async function runBotTurn(deps: Pick<Deps, 'env' | 'db'>, io: BotIO, llm: LlmClient, opts: TurnOptions = {}): Promise<TurnResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const result: TurnResult = { reply: null, handoff: false, tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, iterations: 0, stopReason: null, error: null };

  const [knowledge, hoursRaw, config, customer, memory, failed] = await Promise.all([
    getKnowledge(deps.db, deps.env),
    getSetting<unknown>(deps.db, SETTINGS.businessHours, null),
    getBotConfig(deps),
    io.customer(),
    io.memory(),
    io.failedAttempts(),
  ]);
  const hours = parseBusinessHours(hoursRaw);
  const humanOpen = !opts.forceClosed && isOpenAt(now, hours);
  const next = humanOpen ? null : nextOpening(now, hours);

  const history = buildHistoryMessages(memory.recent);
  if (!history.length) {
    result.error = 'Sem mensagem do cliente para responder';
    return result;
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildStaticSystemPrompt(knowledge.content), cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: buildDynamicContext({
        now,
        timeZone: hours.timezone,
        humanOpen,
        nextOpening: next,
        hoursDescription: describeHours(hours),
        customer: { name: customer.name, phone: customer.phone, hasDocument: Boolean(customer.document) },
        failedAttempts: failed,
        maxFailedAttempts: config.maxFailedAttempts,
        summary: memory.summary,
      }),
    },
  ];

  const ctx: ToolContext = { deps, io, humanOpen, nextOpening: next, imagesSent: 0 };
  const messages: Anthropic.MessageParam[] = [...history];
  let lastText = '';

  try {
    for (;;) {
      if (result.iterations >= MAX_TOOL_ROUNDS) {
        result.error = `Passou de ${MAX_TOOL_ROUNDS} rodadas de ferramentas`;
        break;
      }
      result.iterations++;
      const res = await llm.create({
        max_tokens: deps.env.ANTHROPIC_MAX_TOKENS,
        system,
        tools: BOT_TOOLS,
        messages,
        output_config: { effort: deps.env.ANTHROPIC_EFFORT },
      });
      result.usage.input += res.usage.input_tokens;
      result.usage.output += res.usage.output_tokens;
      result.usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      result.usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      result.stopReason = res.stop_reason;

      if (res.stop_reason === 'refusal') {
        // Recusa por segurança: não responde nada gerado; passa para a equipe.
        result.error = 'O modelo recusou responder (refusal)';
        if (!result.handoff) {
          await io.handoff('o assistente não pôde responder esta mensagem');
          result.handoff = true;
        }
        lastText = DEFAULT_HANDOFF_MESSAGE;
        break;
      }

      const text = textOf(res.content);
      if (text) lastText = text;
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !toolUses.length) break;

      // A resposta inteira (thinking + texto + tool_use) volta sem alteração.
      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const t0 = Date.now();
        const r = await runTool(ctx, call.name, call.input);
        if (r.handoff) result.handoff = true;
        result.tools.push({ name: call.name, input: call.input, ok: !r.isError, outcome: r.outcome, ms: Date.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    result.error = (err as Error).message;
    log.error({ err: result.error }, 'Falha ao chamar o modelo');
    if (!result.handoff) {
      await io.handoff('erro técnico no bot (detalhes em Bot de IA → Registros)').catch(() => undefined);
      result.handoff = true;
    }
    lastText = FALLBACK_ERROR_MESSAGE;
  }

  if (!lastText && !result.handoff && !result.error) result.error = `Resposta vazia do modelo (stop_reason ${result.stopReason})`;
  if (result.error && !lastText) {
    // Ex.: muitas rodadas de ferramentas sem resposta final.
    if (!result.handoff) {
      await io.handoff('o assistente não conseguiu concluir a resposta');
      result.handoff = true;
    }
    lastText = DEFAULT_HANDOFF_MESSAGE;
  }

  // Regra das tentativas sem resolver (contada pelo resultado das ferramentas).
  if (!result.handoff && config.maxFailedAttempts > 0) {
    const outcomes = result.tools.filter((t) => t.name !== 'transferir_para_humano' && t.name !== 'enviar_imagem_produto').map((t) => t.outcome);
    if (outcomes.includes('ok')) {
      if (failed !== 0) await io.setFailedAttempts(0);
    } else if (outcomes.length) {
      const n = failed + 1;
      if (n >= config.maxFailedAttempts) {
        await io.handoff(`${n} tentativas sem resolver`);
        result.handoff = true;
        lastText = lastText ? `${lastText}\n\n${FAILED_ATTEMPTS_MESSAGE}` : FAILED_ATTEMPTS_MESSAGE;
      } else {
        await io.setFailedAttempts(n);
      }
    }
  }

  if (result.handoff && !lastText) lastText = DEFAULT_HANDOFF_MESSAGE;
  const reply = lastText ? cleanReply(lastText) : null;
  if (reply) {
    try {
      await io.sendText(reply);
      result.reply = reply;
    } catch (err) {
      result.error = `${result.error ? `${result.error}; ` : ''}falha ao enviar: ${(err as Error).message}`;
    }
  }

  await io.log({
    model: llm.model,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    cacheReadTokens: result.usage.cacheRead,
    cacheWriteTokens: result.usage.cacheWrite,
    toolsCalled: result.tools.map((t) => ({ ...t, input: t.input as object })),
    replyText: result.reply,
    latencyMs: Date.now() - started,
    error: result.error,
    iterations: result.iterations,
    stopReason: result.stopReason,
    handoff: result.handoff,
  });

  // Memória: resume as mensagens antigas fora da janela (não atrasa a resposta, que já foi enviada).
  if (memory.pendingOlder.length >= SUMMARY_BATCH) {
    await summarize(llm, memory.summary, memory.pendingOlder)
      .then((s) => (s ? memory.commitSummary(s) : undefined))
      .catch((err: Error) => log.warn({ err: err.message }, 'Não foi possível atualizar o resumo'));
  }
  return result;
}

async function summarize(llm: LlmClient, previous: string | null, items: { role: 'user' | 'assistant'; text: string }[]): Promise<string | null> {
  const res = await llm.create({
    max_tokens: 2000,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: buildSummaryPrompt(previous, items) }],
  });
  if (res.stop_reason === 'refusal') return null;
  return textOf(res.content).slice(0, 3000) || null;
}
