import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inboundTextPayload } from '../src/dev/payloads.js';
import { buildTemplateComponents, createTemplateSchema, renderTemplate } from '../src/templates/service.js';
import { ADMIN, createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, TEST_SETUP_TOKEN, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.meta.reset();
});

describe('autenticação do painel', () => {
  it('status pede primeiro acesso quando não há usuário', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.json()).toEqual({ setupRequired: true, user: null });
  });

  it('primeiro acesso exige o código de instalação e senha forte', async () => {
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { ...ADMIN, setupToken: 'errado' } });
    expect(wrong.statusCode).toBe(403);
    const weak = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: ADMIN.email, password: 'fraca', setupToken: TEST_SETUP_TOKEN },
    });
    expect(weak.statusCode).toBe(400);
    expect(await ctx.db.user.count()).toBe(0);
  });

  it('cria o acesso uma única vez, guarda hash bcrypt e cookie seguro', async () => {
    const { cookie } = await loginAsAdmin(ctx.app);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    const user = await ctx.db.user.findFirstOrThrow();
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user.passwordHash).not.toContain(ADMIN.password);
    // sessão guardada só como hash
    const session = await ctx.db.session.findFirstOrThrow();
    expect(session.id).not.toBe(cookie.value);

    const again = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { ...ADMIN, setupToken: TEST_SETUP_TOKEN } });
    expect(again.statusCode).toBe(409);
  });

  it('login com senha errada é recusado; com a certa, entra', async () => {
    await loginAsAdmin(ctx.app);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN.email, password: 'Errada-123456' } });
    expect(bad.statusCode).toBe(401);
    const ghost = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.com', password: 'Errada-123456' } });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().error).toBe(bad.json().error); // não revela se o e-mail existe
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(ok.statusCode).toBe(200);
  });

  it('rotas protegidas exigem sessão e, para alterar dados, o cabeçalho anti-CSRF', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/numbers' })).statusCode).toBe(401);
    const { cookie } = await loginAsAdmin(ctx.app);
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates/sync',
      headers: { cookie: `oh_session=${cookie.value}` },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('bloqueia o login após muitas tentativas, com mensagem legível', async () => {
    process.env.TEST_LOGIN_RATE_LIMIT = '3';
    const limited = await createTestContext();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await limited.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN.email, password: 'Errada-123456' } });
        codes.push(r.statusCode);
        if (r.statusCode === 429) expect(r.json().error).toMatch(/Muitas tentativas/);
      }
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      delete process.env.TEST_LOGIN_RATE_LIMIT;
      await limited.close();
    }
  });

  it('logout encerra a sessão', async () => {
    const admin = await loginAsAdmin(ctx.app);
    expect((await admin.call('POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await admin.call('GET', '/api/numbers')).statusCode).toBe(401);
  });
});

describe('números', () => {
  it('cadastra validando na Meta, criptografa o token e nunca o devolve', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const res = await admin.call('POST', '/api/numbers', {
      phoneNumberId: '1234567890',
      wabaId: '9876543210',
      displayName: 'Oliver Campanhas',
      accessToken: 'EAAG-token-proprio-do-numero-123456',
      role: 'CAMPAIGNS',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().number;
    expect(body).toMatchObject({ displayName: 'Oliver Campanhas', role: 'CAMPAIGNS', qualityRating: 'HIGH', messagingTier: 'TIER_1K', hasOwnToken: true });
    expect(JSON.stringify(res.json())).not.toContain('EAAG');
    const row = await ctx.db.phoneNumber.findUniqueOrThrow({ where: { phoneNumberId: '1234567890' } });
    expect(row.accessTokenEnc).toMatch(/^v1:/);
    expect(row.dailyConversationLimit).toBe(1000);

    const dup = await admin.call('POST', '/api/numbers', { phoneNumberId: '1234567890', wabaId: '9876543210' });
    expect(dup.statusCode).toBe(409);
  });

  it('lista com estatísticas de envio do dia/mês', async () => {
    const admin = await loginAsAdmin(ctx.app);
    await seedNumber(ctx.db);
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5511988887777', text: 'Oi' }));
    await ctx.bus.drain();
    const res = await admin.call('GET', '/api/numbers');
    const [n] = res.json().numbers;
    expect(n.stats).toEqual({ sentToday: 1, sentMonth: 1, activeCampaigns: 0, unreadAlerts: 0 });
  });

  it('sincronizar aplica a política de qualidade (MÉDIA reduz o ritmo)', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const n = await seedNumber(ctx.db);
    ctx.meta.numberInfo = { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_10K', status: 'CONNECTED' };
    const res = await admin.call('POST', `/api/numbers/${n.id}/sync`);
    expect(res.statusCode).toBe(200);
    expect(res.json().number).toMatchObject({ qualityRating: 'MEDIUM', sendRatePerMinute: 10, messagingTier: 'TIER_10K', dailyConversationLimit: 10000 });
    expect(await ctx.db.alert.count({ where: { type: 'QUALITY_MEDIUM' } })).toBe(1);
  });

  it('não deixa retomar campanhas com qualidade BAIXA', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const n = await ctx.db.phoneNumber.create({
      data: { phoneNumberId: PNID, wabaId: WABA, displayName: 'X', qualityRating: 'LOW', campaignsPaused: true },
    });
    expect((await admin.call('POST', `/api/numbers/${n.id}/resume-campaigns`)).statusCode).toBe(409);
    await ctx.db.phoneNumber.update({ where: { id: n.id }, data: { qualityRating: 'HIGH' } });
    const ok = await admin.call('POST', `/api/numbers/${n.id}/resume-campaigns`);
    expect(ok.json().number.campaignsPaused).toBe(false);
  });

  it('testar envio: template fora da janela, texto dentro', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const n = await seedNumber(ctx.db);
    const first = await admin.call('POST', `/api/numbers/${n.id}/test`, { to: '(11) 97777-6666' });
    expect(first.json()).toMatchObject({ mode: 'template', template: 'hello_world' });
    expect(ctx.meta.sent[0]?.body).toMatchObject({ to: '5511977776666', type: 'template' });

    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5511977776666', text: 'recebi' }));
    await ctx.bus.drain();
    const second = await admin.call('POST', `/api/numbers/${n.id}/test`, { to: '11977776666' });
    expect(second.json().mode).toBe('text');

    const bad = await admin.call('POST', `/api/numbers/${n.id}/test`, { to: '1234' });
    expect(bad.statusCode).toBe(400);
  });

  it('importa os números da WABA', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const res = await admin.call('POST', '/api/numbers/import', { wabaId: WABA });
    expect(res.json()).toMatchObject({ found: 1, created: ['55 11 4000-1234'] });
    const again = await admin.call('POST', '/api/numbers/import', { wabaId: WABA });
    expect(again.json().created).toEqual([]);
  });

  it('desliga o bot de um número', async () => {
    const admin = await loginAsAdmin(ctx.app);
    const n = await seedNumber(ctx.db);
    const res = await admin.call('PATCH', `/api/numbers/${n.id}`, { botEnabled: false, baseSendRatePerMinute: 30 });
    expect(res.json().number).toMatchObject({ botEnabled: false, baseSendRatePerMinute: 30, sendRatePerMinute: 30 });
  });
});

describe('templates', () => {
  it('sincroniza da Meta com status e pré-visualização', async () => {
    const admin = await loginAsAdmin(ctx.app);
    await seedNumber(ctx.db);
    const sync = await admin.call('POST', '/api/templates/sync');
    expect(sync.json()).toEqual({ total: 2 });
    const list = await admin.call('GET', '/api/templates');
    const promo = list.json().templates.find((t: { name: string }) => t.name === 'promo_arabes');
    expect(promo).toMatchObject({ status: 'APPROVED', category: 'MARKETING', variables: { header: 0, body: 2 } });
    expect(promo.preview).toContain('Oi Maria! Chegaram novidades de Lattafa');
  });

  it('marca como DELETED o template excluído na Meta', async () => {
    const admin = await loginAsAdmin(ctx.app);
    await seedNumber(ctx.db);
    await admin.call('POST', '/api/templates/sync');
    ctx.meta.templates = ctx.meta.templates.filter((t) => t.name !== 'promo_arabes');
    await admin.call('POST', '/api/templates/sync');
    const row = await ctx.db.template.findFirstOrThrow({ where: { name: 'promo_arabes' } });
    expect(row.status).toBe('DELETED');
  });

  it('cria template de marketing com botão "Parar promoções" e envia para aprovação', async () => {
    const admin = await loginAsAdmin(ctx.app);
    await seedNumber(ctx.db);
    const res = await admin.call('POST', '/api/templates', {
      name: 'novidades_body_splash',
      category: 'MARKETING',
      body: 'Oi {{1}}! O body splash {{2}} chegou 💜',
      bodyExamples: ['Ana', 'Brand Collection'],
      footer: 'Oliver Cosmetics',
      quickReplies: ['Quero ver'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().template.status).toBe('PENDING');
    const sent = ctx.meta.templates.find((t) => t.name === 'novidades_body_splash');
    expect(JSON.stringify(sent?.components)).toContain('Parar promoções');
    expect(JSON.stringify(sent?.components)).toContain('"body_text":[["Ana","Brand Collection"]]');
  });

  it('valida variáveis e exemplos', () => {
    const base = { name: 'x', category: 'UTILITY' as const };
    expect(() => buildTemplateComponents(createTemplateSchema.parse({ ...base, body: 'Oi {{1}} e {{3}}', bodyExamples: ['a', 'b'] }))).toThrow(/sequência/);
    expect(() => buildTemplateComponents(createTemplateSchema.parse({ ...base, body: 'Oi {{1}}' }))).toThrow(/exemplo/);
    expect(createTemplateSchema.safeParse({ ...base, name: 'Promo Natal', body: 'oi' }).success).toBe(false);
  });

  it('renderiza o texto final com as variáveis', () => {
    const comps = buildTemplateComponents(
      createTemplateSchema.parse({ name: 'x', category: 'UTILITY', header: 'Pedido {{1}}', headerExample: '123', body: 'Olá {{1}}', bodyExamples: ['Bia'] }),
    );
    expect(renderTemplate(comps, { header: ['987'], body: ['Carla'] })).toBe('*Pedido 987*\n\nOlá Carla');
  });
});

describe('visão geral', () => {
  it('traz números, alertas e totais; liga/desliga o bot global', async () => {
    const admin = await loginAsAdmin(ctx.app);
    await seedNumber(ctx.db);
    await ctx.db.alert.create({ data: { type: 'QUALITY_LOW', message: 'teste', level: 'CRITICAL' } });
    const dash = await admin.call('GET', '/api/dashboard');
    expect(dash.json()).toMatchObject({ bot: { enabled: true }, totals: { contacts: 0 } });
    expect(dash.json().alerts).toHaveLength(1);

    await admin.call('PUT', '/api/settings/bot', { enabled: false });
    expect((await admin.call('GET', '/api/dashboard')).json().bot.enabled).toBe(false);
    await admin.call('POST', '/api/alerts/read-all');
    expect((await admin.call('GET', '/api/dashboard')).json().alerts).toHaveLength(0);
  });
});
