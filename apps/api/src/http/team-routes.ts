import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, passwordProblems } from '../auth/password.js';
import { destroyAllSessions } from '../auth/session.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { createTemplate } from '../templates/service.js';
import { ALERT_INFO, ALERT_KINDS, getAlertConfig, saveAlertConfig } from '../team/alerts.js';
import { badRequest, HttpError, notFound, parse } from './errors.js';

const log = childLogger('equipe');

const roleSchema = z.enum(['ADMIN', 'ATENDENTE']);

function requireAdmin(req: FastifyRequest) {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador pode gerenciar a equipe.');
}

const phoneField = z
  .string()
  .trim()
  .max(30)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (!v) return v === undefined ? undefined : null;
    const e164 = normalizePhone(v);
    if (!e164) ctx.addIssue({ code: 'custom', message: 'WhatsApp inválido: use DDD + número' });
    return e164 ?? null;
  });
const alertFields = { phone: phoneField, alertNewOrders: z.boolean().optional(), alertStuck: z.boolean().optional(), alertDaily: z.boolean().optional() };

function checkPassword(p: string) {
  const problem = passwordProblems(p);
  if (problem) throw badRequest(problem);
}

/**
 * Equipe do painel (vários acessos). Só o administrador cria, edita, desativa e troca senha.
 * Regras: sempre sobra pelo menos um administrador ativo; ninguém desativa ou rebaixa a si mesmo.
 */
export async function teamRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  /** Lista curta para escolher o responsável por uma conversa (qualquer usuário). */
  app.get('/team/members', async () => {
    const users = await deps.db.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true } });
    return { members: users.map((u) => ({ id: u.id, name: u.name || u.email.split('@')[0] })) };
  });

  // ── Avisos para a equipe (WhatsApp de cada pessoa) ──
  app.get('/team/alerts', async (req) => {
    requireAdmin(req);
    const [config, templates, log] = await Promise.all([
      getAlertConfig(deps.db),
      deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, select: { name: true, status: true, rejectedReason: true } }),
      deps.db.teamAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const users = new Map((await deps.db.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
    return {
      config,
      kinds: ALERT_KINDS.map((k) => ({ key: k, label: ALERT_INFO[k].label, when: ALERT_INFO[k].when, body: ALERT_INFO[k].suggested.body, template: templates.find((t) => t.name === config.templates[k]) ?? null })),
      log: log.map((l) => ({ ...l, userName: users.get(l.userId) ?? null })),
    };
  });

  app.put('/team/alerts', async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        stuckHour: z.number().int().min(0).max(23),
        summaryHour: z.number().int().min(0).max(23),
        phoneNumberId: z.string().nullable(),
        templates: z.object(Object.fromEntries(ALERT_KINDS.map((k) => [k, z.string().trim().regex(/^[a-z0-9_]+$/)])) as Record<(typeof ALERT_KINDS)[number], z.ZodString>),
      }),
      req.body,
    );
    await saveAlertConfig(deps.db, body);
    return { config: await getAlertConfig(deps.db) };
  });

  app.post('/team/alerts/templates', async (req) => {
    requireAdmin(req);
    const cfg = await getAlertConfig(deps.db);
    const results = [];
    for (const k of ALERT_KINDS) {
      const s = ALERT_INFO[k].suggested;
      const name = cfg.templates[k];
      const existing = await deps.db.template.findFirst({ where: { name, status: { not: 'DELETED' } } });
      if (existing) {
        results.push({ kind: k, name, status: existing.status });
        continue;
      }
      try {
        const row = await createTemplate(deps, { name, language: 'pt_BR', category: 'UTILITY', body: s.body, bodyExamples: s.examples, quickReplies: [], addOptOutButton: false });
        results.push({ kind: k, name, status: row.status });
      } catch (err) {
        results.push({ kind: k, name, status: 'ERRO', error: (err as Error).message });
      }
    }
    return { results };
  });

  app.get('/team', async (req) => {
    requireAdmin(req);
    const users = await deps.db.user.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    const open = await deps.db.conversation.groupBy({ by: ['assignedToId'], where: { assignedToId: { not: null }, handler: 'HUMAN' }, _count: { _all: true } });
    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
        twoFactor: Boolean(u.totpSecret),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        openConversations: open.find((o) => o.assignedToId === u.id)?._count._all ?? 0,
        phone: u.phone,
        alertNewOrders: u.alertNewOrders,
        alertStuck: u.alertStuck,
        alertDaily: u.alertDaily,
        me: u.id === req.user!.id,
      })),
    };
  });

  app.post('/team', async (req, reply) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2, 'informe o nome').max(60),
        email: z.string().trim().toLowerCase().email('e-mail inválido').max(200),
        role: roleSchema.default('ATENDENTE'),
        password: z.string().min(1, 'informe a senha inicial').max(128),
        ...alertFields,
      }),
      req.body,
    );
    checkPassword(body.password);
    if (await deps.db.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, 'Já existe um acesso com este e-mail.');
    const user = await deps.db.user.create({
      data: {
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        phone: body.phone ?? null,
        alertNewOrders: body.alertNewOrders ?? false,
        alertStuck: body.alertStuck ?? false,
        alertDaily: body.alertDaily ?? false,
      },
    });
    log.info({ by: req.user!.email, email: user.email, role: user.role }, 'Acesso criado');
    return reply.code(201).send({ user: { id: user.id } });
  });

  app.patch('/team/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({
        name: z.string().trim().min(2, 'informe o nome').max(60).optional(),
        email: z.string().trim().toLowerCase().email('e-mail inválido').max(200).optional(),
        role: roleSchema.optional(),
        active: z.boolean().optional(),
        password: z.string().min(1).max(128).optional(),
        resetTwoFactor: z.literal(true).optional(),
        ...alertFields,
      }),
      req.body,
    );
    const user = await deps.db.user.findUnique({ where: { id } });
    if (!user) throw notFound('Acesso não encontrado');
    const self = user.id === req.user!.id;
    if (self && (body.active === false || body.role === 'ATENDENTE')) {
      throw badRequest('Você não pode desativar nem tirar o administrador do seu próprio acesso.');
    }
    const losesAdmin = user.role === 'ADMIN' && user.active && (body.role === 'ATENDENTE' || body.active === false);
    if (losesAdmin) {
      const admins = await deps.db.user.count({ where: { role: 'ADMIN', active: true } });
      if (admins <= 1) throw badRequest('Precisa sobrar pelo menos um administrador ativo.');
    }
    if (body.email && body.email !== user.email && (await deps.db.user.findUnique({ where: { email: body.email } }))) {
      throw new HttpError(409, 'Já existe um acesso com este e-mail.');
    }
    if (body.password) checkPassword(body.password);

    await deps.db.user.update({
      where: { id },
      data: {
        name: body.name,
        email: body.email,
        role: body.role,
        active: body.active,
        phone: body.phone,
        alertNewOrders: body.alertNewOrders,
        alertStuck: body.alertStuck,
        alertDaily: body.alertDaily,
        ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
        ...(body.resetTwoFactor
          ? { totpSecret: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] }
          : {}),
      },
    });
    // desativado, nova senha ou 2FA zerado: derruba as sessões abertas dessa pessoa
    if (!self && (body.active === false || body.password || body.resetTwoFactor)) await destroyAllSessions(deps.db, id);
    if (body.active === false) {
      // as conversas dela voltam para a fila (sem responsável)
      await deps.db.conversation.updateMany({ where: { assignedToId: id }, data: { assignedToId: null } });
    }
    log.info(
      { by: req.user!.email, email: user.email, changes: Object.keys(body).filter((k) => k !== 'password').concat(body.password ? ['senha'] : []) },
      'Acesso alterado',
    );
    return { ok: true };
  });
}
