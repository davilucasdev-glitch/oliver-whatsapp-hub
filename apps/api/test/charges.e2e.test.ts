import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, CHARGE_INFO, CHARGE_KINDS, daysBetween, spDate } from '../src/charges/config.js';
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

const PIX = 'pix@oliver.com.br';

async function approvedTemplates() {
  for (const k of CHARGE_KINDS) {
    const s = CHARGE_INFO[k].suggested;
    await ctx.db.template.create({
      data: { wabaId: WABA, name: s.name, language: 'pt_BR', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: s.body, example: { body_text: [s.examples] } }] },
    });
  }
}

async function setup(cfg: Record<string, unknown> = {}) {
  await seedNumber(ctx.db);
  await connectBling(ctx, admin.call);
  await approvedTemplates();
  const { config } = (await admin.call('GET', '/api/charges')).json();
  expect((await admin.call('PUT', '/api/charges/config', { ...config, pixKey: PIX, ...cfg })).statusCode).toBe(200);
  const sync = await admin.call('POST', '/api/charges/sync');
  expect(sync.statusCode, sync.body).toBe(200);
  return sync.json();
}

type Row = { key: string; name: string; amount: number; balance: number; balanceKnown: boolean; daysLate: number | null; variables: string[]; blocked: string | null; alreadySent: boolean; phone: string | null };
const lists = async () => (await admin.call('GET', '/api/charges')).json() as { lembrete: Row[]; hoje: Row[]; atraso: Row[]; pagos: Row[] };
const lastTemplate = () => {
  const b = ctx.meta.sent.at(-1)?.body as { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } };
  return { to: b.to, name: b.template.name, params: b.template.components[0]?.parameters.map((p) => p.text) };
};
const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;

describe('datas da cobrança', () => {
  it('dias e datas no horário de Brasília', () => {
    expect(spDate(new Date('2026-11-19T02:30:00Z'))).toBe('2026-11-18');
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(daysBetween('2026-11-13', '2026-11-18')).toBe(5);
  });
});

describe('cobrança e crediário', () => {
  it('monta as listas pelas regras: corte por emissão, TikTok fora, parcial pelo borderô', async () => {
    const sync = await setup();
    expect(sync.unknownRemaining).toBe(1); // a parcial do João sem borderô
    const l = await lists();
    const today = spDate();

    expect(l.lembrete).toHaveLength(1);
    expect(l.lembrete[0]).toMatchObject({ name: 'Maria Souza', amount: 278, phone: '+5511988887777', blocked: null });
    expect(l.lembrete[0]!.variables).toEqual(['Maria', 'R$ 278,00', ddmm(addDays(today, 2)), PIX]);

    expect(l.hoje.map((r) => [r.name, r.amount])).toEqual([['João Lima', 55]]);
    expect(l.hoje[0]!.variables).toEqual(['João', 'R$ 55,00', PIX]);

    // atraso: maior atraso primeiro; Maria só com a parcial (TikTok e antes do corte ficam fora)
    expect(l.atraso.map((r) => r.name)).toEqual(['Maria Souza', 'João Lima', 'ANA PAULA SILVA']);
    const [maria, joao, ana] = l.atraso as [Row, Row, Row];
    expect(maria).toMatchObject({ amount: 200, daysLate: 8, balance: 756, balanceKnown: true });
    expect(maria.variables).toEqual(['Maria', 'R$ 200,00', '8 dias', 'R$ 756,00']);
    expect(joao).toMatchObject({ amount: 250, daysLate: 5, balanceKnown: false });
    expect(ana.blocked).toMatch(/Sem telefone/);
  });

  it('um clique envia; não envia duas vezes; quem cobrou fica registrado', async () => {
    await setup();
    const key = (await lists()).lembrete[0]!.key;
    const res = await admin.call('POST', '/api/charges/send', { key });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('SENT');
    expect(lastTemplate()).toMatchObject({ to: '5511988887777', name: 'cobranca_lembrete' });

    expect((await admin.call('POST', '/api/charges/send', { key })).statusCode).toBe(409);
    expect(ctx.meta.sent).toHaveLength(1);
    const l = await lists();
    expect(l.lembrete[0]).toMatchObject({ alreadySent: true });
    // a mensagem sai como da equipe (o bot não responde em cima da cobrança)
    const conv = await ctx.db.conversation.findFirstOrThrow({ where: { contact: { phone: '+5511988887777' } } });
    expect(conv.handler).toBe('HUMAN');
    const msg = await ctx.db.message.findFirstOrThrow({ where: { templateName: 'cobranca_lembrete' } });
    expect(msg.sentBy).toBe('HUMAN');
    expect(msg.sentByUserId).not.toBeNull();
  });

  it('saldo desconhecido (parcial sem borderô) pede o saldo do crediário antes de enviar', async () => {
    await setup();
    const joao = (await lists()).atraso.find((r) => r.name === 'João Lima')!;
    const sem = await admin.call('POST', '/api/charges/send', { key: joao.key });
    expect(sem.statusCode).toBe(400);
    expect(sem.json().error).toMatch(/Confira o saldo no crediário/);
    const com = await admin.call('POST', '/api/charges/send', { key: joao.key, balance: 305 });
    expect(com.json().status).toBe('SENT');
    expect(lastTemplate().params).toEqual(['João', 'R$ 250,00', '5 dias', 'R$ 305,00']);
  });

  it('cobrança fica com a responsável escolhida (Ellen)', async () => {
    const ellen = await admin.call('POST', '/api/team', { name: 'Ellen', email: 'ellen@exemplo.com.br', role: 'ATENDENTE', password: 'Ellen-Senha-2026' });
    await setup({ ownerUserId: ellen.json().user.id });
    const key = (await lists()).hoje[0]!.key;
    const r = await admin.call('POST', '/api/charges/send', { key });
    const conv = await ctx.db.conversation.findUniqueOrThrow({ where: { id: r.json().conversationId } });
    expect(conv.assignedToId).toBe(ellen.json().user.id);
  });

  it('pagamento recebido só depois da baixa no Bling, com o valor pago e o saldo que ficou', async () => {
    await setup();
    expect((await lists()).pagos).toHaveLength(0);

    ctx.bling.payReceivable(7008, 50); // Maria pagou mais 50 da parcial
    ctx.bling.payReceivable(7004); // João quitou a de 100
    await admin.call('POST', '/api/charges/sync');
    const l = await lists();
    const maria = l.pagos.find((r) => r.name === 'Maria Souza')!;
    expect(maria).toMatchObject({ amount: 50, balance: 706, balanceKnown: true });
    expect(maria.variables).toEqual(['Maria', 'R$ 50,00', 'R$ 706,00']);
    const joao = l.pagos.find((r) => r.name === 'João Lima')!;
    expect(joao).toMatchObject({ amount: 100, balanceKnown: false });
    // a de 100 saiu do atraso do João
    expect(l.atraso.find((r) => r.name === 'João Lima')).toMatchObject({ amount: 150 });

    const res = await admin.call('POST', '/api/charges/send', { key: maria.key });
    expect(res.json().status).toBe('SENT');
    expect(lastTemplate()).toMatchObject({ name: 'cobranca_pagamento_recebido', params: ['Maria', 'R$ 50,00', 'R$ 706,00'] });

    // sync de novo sem pagamento novo: o agradecimento não volta
    await admin.call('POST', '/api/charges/sync');
    expect((await lists()).pagos.find((r) => r.name === 'Maria Souza')).toMatchObject({ alreadySent: true });
  });

  it('sem chave Pix, lembrete e vence hoje ficam bloqueados; enviar vários de uma vez', async () => {
    await setup({ pixKey: '' });
    let l = await lists();
    expect(l.lembrete[0]!.blocked).toMatch(/chave Pix/);
    const { config } = (await admin.call('GET', '/api/charges')).json();
    await admin.call('PUT', '/api/charges/config', { ...config, pixKey: PIX });
    l = await lists();
    const many = await admin.call('POST', '/api/charges/send-many', { keys: [l.lembrete[0]!.key, l.hoje[0]!.key, l.atraso.find((r) => r.name === 'ANA PAULA SILVA')!.key] });
    expect(many.json().sent).toBe(2);
    expect(many.json().results[2]).toMatchObject({ status: 'FAILED' });
    expect(ctx.meta.sent).toHaveLength(2);
    const hist = (await admin.call('GET', '/api/charges/history')).json().history;
    expect(hist).toHaveLength(2);
    expect(hist[0].sentBy).toBe('oliver');
  });

  it('erro da Meta fica registrado e dá para tentar de novo', async () => {
    await setup();
    const key = (await lists()).hoje[0]!.key;
    ctx.meta.failNext = { status: 400, code: 131026, message: 'Message undeliverable' };
    expect((await admin.call('POST', '/api/charges/send', { key })).json().status).toBe('FAILED');
    expect((await admin.call('POST', '/api/charges/send', { key })).json().status).toBe('SENT');
  });

  it('cria os templates de cobrança na Meta (Utilidade); atendente não muda a configuração', async () => {
    await seedNumber(ctx.db);
    const res = (await admin.call('POST', '/api/charges/templates')).json();
    expect(res.results.map((r: { status: string }) => r.status)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    expect(ctx.meta.templates.filter((t) => t.name.startsWith('cobranca_')).every((t) => t.category === 'UTILITY')).toBe(true);

    await admin.call('POST', '/api/team', { name: 'Gabi', email: 'gabi@exemplo.com.br', role: 'ATENDENTE', password: 'Gabi-Senha-2026' });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'gabi@exemplo.com.br', password: 'Gabi-Senha-2026' } });
    const cookie = login.cookies.find((c) => c.name === 'oh_session')!;
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/charges/config', headers: { cookie: `oh_session=${cookie.value}`, 'x-oliver-panel': '1' }, payload: {} });
    expect(put.statusCode).toBe(403);
  });
});
