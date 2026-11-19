import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CHARGE_INFO, CHARGE_KINDS, getChargeConfig, getChargeSyncState, saveChargeConfig, spDate } from '../charges/config.js';
import { buildChargeLists, sendCharge } from '../charges/service.js';
import { syncReceivables } from '../charges/sync.js';
import type { Deps } from '../deps.js';
import type { Agent } from '../inbox/service.js';
import { createTemplate } from '../templates/service.js';
import { badRequest, HttpError, parse } from './errors.js';

const agent = (req: FastifyRequest): Agent => ({ id: req.user!.id, name: req.user!.name || req.user!.email.split('@')[0]! });

function requireAdmin(req: FastifyRequest) {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Só o administrador muda as configurações de cobrança.');
}

const configSchema = z.object({
  pixKey: z.string().trim().max(120),
  cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data de corte inválida'),
  reminderDays: z.number().int().min(1).max(10),
  ownerUserId: z.string().nullable(),
  phoneNumberId: z.string().nullable(),
  templates: z.object(
    Object.fromEntries(CHARGE_KINDS.map((k) => [k, z.string().trim().regex(/^[a-z0-9_]+$/, 'nome de template inválido')])) as Record<(typeof CHARGE_KINDS)[number], z.ZodString>,
  ),
});

export async function chargeRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/charges', async () => {
    const [lists, config, sync, blingAuth, users, numbers, templates] = await Promise.all([
      buildChargeLists(deps),
      getChargeConfig(deps.db),
      getChargeSyncState(deps.db),
      deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }),
      deps.db.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
      deps.db.phoneNumber.findMany({ where: { isActive: true }, select: { id: true, displayName: true, displayPhone: true }, orderBy: { createdAt: 'asc' } }),
      deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, select: { name: true, status: true, rejectedReason: true } }),
    ]);
    return {
      ...lists,
      config,
      sync,
      blingConnected: Boolean(blingAuth),
      kinds: CHARGE_KINDS.map((k) => ({ key: k, ...CHARGE_INFO[k], template: templates.find((t) => t.name === config.templates[k]) ?? null })),
      users: users.map((u) => ({ id: u.id, name: u.name || u.email.split('@')[0] })),
      numbers,
    };
  });

  app.post('/charges/sync', async () => {
    if (!(await deps.db.blingAuth.findUnique({ where: { id: 'default' }, select: { id: true } }))) throw badRequest('O Bling não está conectado.');
    try {
      return await syncReceivables(deps);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });

  app.put('/charges/config', async (req) => {
    requireAdmin(req);
    const body = parse(configSchema, req.body);
    await saveChargeConfig(deps.db, body);
    return { config: await getChargeConfig(deps.db) };
  });

  app.post('/charges/templates', async (req) => {
    requireAdmin(req);
    const cfg = await getChargeConfig(deps.db);
    const results: { kind: string; name: string; status: string; error?: string }[] = [];
    for (const k of CHARGE_KINDS) {
      const s = CHARGE_INFO[k].suggested;
      const name = cfg.templates[k];
      const existing = await deps.db.template.findFirst({ where: { name, status: { not: 'DELETED' } } });
      if (existing) {
        results.push({ kind: k, name, status: existing.status });
        continue;
      }
      try {
        const row = await createTemplate(deps, { name, language: 'pt_BR', category: 'UTILITY', body: s.body, bodyExamples: s.examples, footer: 'Oliver Cosméticos', quickReplies: [], addOptOutButton: false });
        results.push({ kind: k, name, status: row.status });
      } catch (err) {
        results.push({ kind: k, name, status: 'ERRO', error: (err as Error).message });
      }
    }
    return { results };
  });

  /** Um clique = uma mensagem. `balance` só quando a Oliver confere o saldo à mão (conta parcial). */
  app.post('/charges/send', async (req) => {
    const body = parse(z.object({ key: z.string().min(3).max(4000), balance: z.number().min(0).max(1_000_000).optional() }), req.body);
    return sendCharge(deps, agent(req), body);
  });

  /** Enviar todos os selecionados (depois de a pessoa confirmar a quantidade na tela). */
  app.post('/charges/send-many', async (req) => {
    const { keys } = parse(z.object({ keys: z.array(z.string().min(3).max(4000)).min(1).max(200) }), req.body);
    const lists = await buildChargeLists(deps);
    const results = [];
    for (const key of keys) {
      try {
        results.push(await sendCharge(deps, agent(req), { key }, lists));
      } catch (err) {
        results.push({ key, status: 'FAILED' as const, reason: (err as Error).message });
      }
    }
    return { results, sent: results.filter((r) => r.status === 'SENT').length };
  });

  app.get('/charges/history', async (req) => {
    const q = parse(z.object({ search: z.string().trim().max(60).optional(), take: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
    const rows = await deps.db.chargeNotice.findMany({
      where: q.search ? { contactName: { contains: q.search, mode: 'insensitive' } } : {},
      orderBy: { createdAt: 'desc' },
      take: q.take,
    });
    const users = new Map((await deps.db.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email.split('@')[0]!]));
    return { today: spDate(), history: rows.map((r) => ({ ...r, sentBy: r.sentByUserId ? (users.get(r.sentByUserId) ?? null) : null })) };
  });
}
