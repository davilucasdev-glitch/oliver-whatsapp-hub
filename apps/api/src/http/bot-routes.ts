import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getLlm } from '../bot/ai-engine.js';
import { BOT_CONFIG_KEY, getBotConfig, runBotTurn } from '../bot/engine.js';
import { businessHoursSchema, DEFAULT_BUSINESS_HOURS, describeHours, isOpenAt, nextOpening, parseBusinessHours } from '../bot/hours.js';
import { simIO, simMessages, type SimMessage } from '../bot/io.js';
import { getKnowledge, KNOWLEDGE_MAX_CHARS, pendingPlaceholders, readKnowledgeFile, saveKnowledge } from '../bot/knowledge.js';
import { apiKeyInfo, BotNotConfiguredError, saveApiKey } from '../bot/llm.js';
import type { Deps } from '../deps.js';
import { normalizePhone } from '../lib/phone.js';
import { getSetting, setSetting, SETTINGS } from '../settings.js';
import { badRequest, HttpError, notFound, parse } from './errors.js';

const settingsSchema = z.object({
  businessHours: businessHoursSchema.optional(),
  maxFailedAttempts: z.number().int().min(0).max(10).optional(),
  /** null apaga a chave salva pelo painel (volta a usar a do .env, se houver) */
  anthropicApiKey: z
    .string()
    .trim()
    .regex(/^sk-ant-[\w-]{20,}$/, 'a chave da Anthropic começa com "sk-ant-"')
    .nullable()
    .optional(),
});

const simCreateSchema = z.object({
  customerName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(30).optional(),
  document: z.string().trim().max(30).optional(),
});

const DEFAULT_SIM_PHONE = '+5511900000000';

function publicSession(s: Prisma.BotSimSessionGetPayload<{ include: { logs: true } }>) {
  return {
    id: s.id,
    customerName: s.customerName,
    phone: s.phone,
    document: s.document,
    messages: simMessages(s.messages),
    summary: s.summary,
    handedOff: s.handedOff,
    handoffReason: s.handoffReason,
    failedAttempts: s.failedAttempts,
    createdAt: s.createdAt,
    logs: s.logs,
  };
}

export async function botRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  // ── Configurações ──
  app.get('/bot/settings', async () => {
    const [enabled, hoursRaw, config, key, numbers] = await Promise.all([
      getSetting<boolean>(db, SETTINGS.botEnabled, true),
      getSetting<unknown>(db, SETTINGS.businessHours, null),
      getBotConfig(deps),
      apiKeyInfo(db, env),
      db.phoneNumber.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, displayPhone: true, botEnabled: true, role: true, isActive: true } }),
    ]);
    const hours = parseBusinessHours(hoursRaw ?? DEFAULT_BUSINESS_HOURS);
    const now = new Date();
    const open = isOpenAt(now, hours);
    return {
      enabled,
      mode: env.BOT_MODE,
      model: env.ANTHROPIC_MODEL,
      effort: env.ANTHROPIC_EFFORT,
      apiKey: key,
      businessHours: hours,
      hoursDescription: describeHours(hours),
      humanOpenNow: open,
      nextOpening: open ? null : nextOpening(now, hours),
      maxFailedAttempts: config.maxFailedAttempts,
      debounceMs: env.BOT_DEBOUNCE_MS,
      numbers,
    };
  });

  app.put('/bot/settings', async (req) => {
    const body = parse(settingsSchema, req.body);
    if (body.businessHours) await setSetting(db, SETTINGS.businessHours, body.businessHours);
    if (body.maxFailedAttempts !== undefined) {
      await setSetting(db, BOT_CONFIG_KEY, { ...(await getBotConfig(deps)), maxFailedAttempts: body.maxFailedAttempts });
    }
    if (body.anthropicApiKey !== undefined) await saveApiKey(db, env, body.anthropicApiKey);
    return { ok: true };
  });

  // ── Base de conhecimento ──
  app.get('/bot/knowledge', async () => {
    const k = await getKnowledge(db, env);
    const versions = await db.knowledgeVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, note: true, createdAt: true } });
    return { ...k, maxChars: KNOWLEDGE_MAX_CHARS, pending: pendingPlaceholders(k.content), versions };
  });

  app.put('/bot/knowledge', async (req) => {
    const { content, note } = parse(z.object({ content: z.string().min(1, 'o texto está vazio').max(KNOWLEDGE_MAX_CHARS), note: z.string().max(200).optional() }), req.body);
    const v = await saveKnowledge(db, content, note);
    return { ok: true, versionId: v.id, pending: pendingPlaceholders(v.content) };
  });

  app.get('/bot/knowledge/versions/:id', async (req) => {
    const v = await db.knowledgeVersion.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!v) throw notFound('Versão não encontrada');
    return { version: v };
  });

  /** Volta ao conteúdo do arquivo knowledge/oliver.md (vira uma nova versão). */
  app.post('/bot/knowledge/restore-file', async () => {
    const file = readKnowledgeFile(env);
    if (!file) throw new HttpError(404, 'Arquivo knowledge/oliver.md não encontrado no servidor.');
    const v = await saveKnowledge(db, file, 'restaurado do arquivo knowledge/oliver.md');
    return { ok: true, versionId: v.id };
  });

  // ── Logs ──
  app.get('/bot/logs', async (req) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        simulated: z.enum(['true', 'false']).optional(),
        problems: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const where: Prisma.BotLogWhereInput = {
      ...(q.simulated ? { simulated: q.simulated === 'true' } : {}),
      ...(q.problems === 'true' ? { OR: [{ error: { not: null } }, { handoff: true }] } : {}),
    };
    const pageSize = 30;
    const [logs, total, totals] = await Promise.all([
      db.botLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        include: { conversation: { select: { id: true, contact: { select: { id: true, name: true, phone: true } } } } },
      }),
      db.botLog.count({ where }),
      db.botLog.aggregate({
        where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
        _count: { _all: true },
      }),
    ]);
    return {
      logs,
      total,
      page: q.page,
      pageSize,
      last30Days: {
        replies: totals._count._all,
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
        cacheReadTokens: totals._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: totals._sum.cacheWriteTokens ?? 0,
      },
    };
  });

  // ── Simulador (conversa com o bot sem WhatsApp) ──
  app.post('/bot/sim/sessions', async (req) => {
    const b = parse(simCreateSchema, req.body ?? {});
    const phone = b.phone ? normalizePhone(b.phone) : DEFAULT_SIM_PHONE;
    if (!phone) throw badRequest('Telefone inválido');
    const s = await db.botSimSession.create({
      data: { customerName: b.customerName || null, phone, document: b.document?.replace(/\D/g, '') || null },
      include: { logs: true },
    });
    // guarda só as 20 sessões mais recentes
    const old = await db.botSimSession.findMany({ orderBy: { createdAt: 'desc' }, skip: 20, select: { id: true } });
    if (old.length) await db.botSimSession.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return { session: publicSession(s) };
  });

  app.get('/bot/sim/sessions/:id', async (req) => {
    const s = await db.botSimSession.findUnique({
      where: { id: (req.params as { id: string }).id },
      include: { logs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!s) throw notFound('Sessão do simulador não encontrada');
    return { session: publicSession(s) };
  });

  app.post('/bot/sim/sessions/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    const { text, forceClosed } = parse(z.object({ text: z.string().trim().min(1).max(2000), forceClosed: z.boolean().default(false) }), req.body);
    const s = await db.botSimSession.findUnique({ where: { id } });
    if (!s) throw notFound('Sessão do simulador não encontrada');
    const list: SimMessage[] = [...simMessages(s.messages), { role: 'user', text, at: new Date().toISOString() }];
    await db.botSimSession.update({ where: { id }, data: { messages: list as unknown as Prisma.InputJsonValue } });

    let turn = null;
    if (!s.handedOff) {
      try {
        const llm = await getLlm(deps);
        turn = await runBotTurn(deps, simIO(deps, id), llm, { forceClosed });
      } catch (err) {
        if (err instanceof BotNotConfiguredError) throw new HttpError(409, err.message);
        throw err;
      }
    }
    const updated = await db.botSimSession.findUniqueOrThrow({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } });
    return { session: publicSession(updated), turn };
  });

  /** "Devolver ao bot" no simulador */
  app.post('/bot/sim/sessions/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    const s = await db.botSimSession.update({ where: { id }, data: { handedOff: false, handoffReason: null }, include: { logs: { orderBy: { createdAt: 'asc' } } } });
    return { session: publicSession(s) };
  });
}
