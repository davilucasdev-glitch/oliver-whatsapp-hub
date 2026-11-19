import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSetting } from '../src/settings.js';
import { ALERT_INFO } from '../src/team/alerts.js';
import { notifyAdmins, runHealthChecks } from '../src/team/health.js';
import { runRetention } from '../src/team/retention.js';
import { connectBling, createTestContext, loginAsAdmin, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAsAdmin>>;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.meta.reset();
  ctx.bling.reset();
  admin = await loginAsAdmin(ctx.app);
});

async function adminComWhatsApp() {
  const me = (await admin.call('GET', '/api/auth/status')).json().user.id;
  expect((await admin.call('PATCH', `/api/team/${me}`, { phone: '63992142094' })).statusCode).toBe(200);
  const s = ALERT_INFO.SISTEMA.suggested;
  await ctx.db.template.create({ data: { wabaId: WABA, name: s.name, language: 'pt_BR', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: s.body, example: { body_text: [s.examples] } }] } });
}

describe('saúde do hub', () => {
  it('Bling desconectado com avisos ligados vira alerta grave, uma vez só', async () => {
    await setSetting(ctx.db, 'orders.notices', { enabled: true, saved: true });
    expect((await runHealthChecks(ctx.deps)).created).toBe(1);
    expect((await runHealthChecks(ctx.deps)).created).toBe(0);
    const a = await ctx.db.alert.findMany();
    expect(a.map((x) => [x.type, x.level])).toEqual([['BLING_DISCONNECTED', 'CRITICAL']]);
  });

  it('leitura de pedidos parada há mais de 15 min vira alerta', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await setSetting(ctx.db, 'orders.notices', { enabled: true, saved: true });
    await setSetting(ctx.db, 'orders.poll', { cursor: null, baselineAt: null, lastRunAt: new Date(Date.now() - 40 * 60_000).toISOString(), lastError: null, lastSummary: null });
    await runHealthChecks(ctx.deps);
    const a = await ctx.db.alert.findFirstOrThrow({ where: { type: 'ORDERS_STALE' } });
    expect(a.message).toMatch(/parada há 40 min/);
  });

  it('número fora do ar na Meta vira alerta', async () => {
    await ctx.db.phoneNumber.create({ data: { phoneNumberId: 'PN2', wabaId: WABA, displayName: 'Oliver 2', status: 'FLAGGED', qualityRating: 'LOW' } });
    await runHealthChecks(ctx.deps);
    expect((await ctx.db.alert.findFirstOrThrow()).message).toMatch(/Oliver 2 está com status FLAGGED/);
  });

  it('alerta grave vai para o WhatsApp do administrador, uma vez; atendente não recebe', async () => {
    await seedNumber(ctx.db);
    await adminComWhatsApp();
    await admin.call('POST', '/api/team', { name: 'Duda', email: 'duda@exemplo.com.br', role: 'ATENDENTE', password: 'Duda-Senha-2026', phone: '63981112222' });
    await ctx.db.alert.create({ data: { level: 'CRITICAL', type: 'BLING_DISCONNECTED', message: 'O Bling está desconectado' } });
    await ctx.db.alert.create({ data: { level: 'WARNING', type: 'X', message: 'aviso leve não vai para o celular' } });
    expect((await notifyAdmins(ctx.deps)).sent).toBe(1);
    const b = ctx.meta.sent.at(-1)!.body as { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } };
    expect(b.to).toBe('5563992142094');
    expect(b.template.name).toBe('equipe_alerta_sistema');
    expect(b.template.components[0]!.parameters[0]!.text).toBe('O Bling está desconectado');
    expect((await notifyAdmins(ctx.deps)).sent).toBe(0);
    expect(ctx.meta.sent).toHaveLength(1);
  });

  it('administrador que desligou os alertas do sistema não recebe', async () => {
    await seedNumber(ctx.db);
    await adminComWhatsApp();
    const me = (await admin.call('GET', '/api/auth/status')).json().user.id;
    await admin.call('PATCH', `/api/team/${me}`, { alertSystem: false });
    await ctx.db.alert.create({ data: { level: 'CRITICAL', type: 'T', message: 'teste' } });
    expect((await notifyAdmins(ctx.deps)).sent).toBe(0);
    expect((await ctx.db.alert.findFirstOrThrow()).notifiedAt).not.toBeNull();
  });
});

describe('guarda dos registros', () => {
  it('apaga só registros técnicos antigos; mensagens e consentimentos ficam', async () => {
    await seedNumber(ctx.db);
    const old = new Date(Date.now() - 400 * 86_400_000);
    await ctx.db.webhookEvent.create({ data: { eventKey: 'velho', kind: 'message', payload: {}, createdAt: old } });
    await ctx.db.webhookEvent.create({ data: { eventKey: 'novo', kind: 'message', payload: {} } });
    await ctx.db.siteWebhookLog.create({ data: { event: 'x', ok: true, createdAt: old } });
    const c = await ctx.db.contact.create({ data: { phone: '+5563992142094', optIn: true } });
    await ctx.db.consentLog.create({ data: { contactId: c.id, action: 'OPT_IN', source: 'teste', createdAt: old } });
    const r = await runRetention(ctx.deps);
    expect(r.removed).toBeGreaterThanOrEqual(2);
    expect(await ctx.db.webhookEvent.count()).toBe(1);
    expect(await ctx.db.siteWebhookLog.count()).toBe(0);
    expect(await ctx.db.consentLog.count()).toBe(1);
  });
});
