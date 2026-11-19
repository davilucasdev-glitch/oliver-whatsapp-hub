import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inboundTextPayload } from '../src/dev/payloads.js';
import { ADMIN, createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

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
  admin = await loginAsAdmin(ctx.app);
});

const DUDA = { name: 'Duda', email: 'duda@exemplo.com.br', password: 'Duda-Senha-2026', role: 'ATENDENTE' };

async function loginAs(email: string, password: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === 'oh_session');
  const headers = cookie ? { cookie: `oh_session=${cookie.value}`, 'x-oliver-panel': '1' } : {};
  return {
    res,
    call: (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
      ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) }),
  };
}

async function createDuda() {
  const res = await admin.call('POST', '/api/team', DUDA);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().user.id as string;
}

describe('equipe', () => {
  it('primeiro acesso é administrador; admin cria atendente que entra com a própria senha', async () => {
    const me = (await admin.call('GET', '/api/auth/status')).json().user;
    expect(me.role).toBe('ADMIN');
    await createDuda();
    const duda = await loginAs(DUDA.email, DUDA.password);
    expect(duda.res.statusCode).toBe(200);
    expect(duda.res.json().user).toMatchObject({ name: 'Duda', role: 'ATENDENTE' });
    const list = (await admin.call('GET', '/api/team')).json().users;
    expect(list.map((u: { email: string }) => u.email).sort()).toEqual([DUDA.email, ADMIN.email].sort());
    expect(list.find((u: { email: string }) => u.email === DUDA.email).lastLoginAt).not.toBeNull();
  });

  it('valida senha fraca e e-mail repetido', async () => {
    expect((await admin.call('POST', '/api/team', { ...DUDA, password: 'fraca' })).statusCode).toBe(400);
    await createDuda();
    expect((await admin.call('POST', '/api/team', DUDA)).statusCode).toBe(409);
  });

  it('atendente não gerencia a equipe', async () => {
    await createDuda();
    const duda = await loginAs(DUDA.email, DUDA.password);
    expect((await duda.call('GET', '/api/team')).statusCode).toBe(403);
    expect((await duda.call('POST', '/api/team', { ...DUDA, email: 'x@exemplo.com.br' })).statusCode).toBe(403);
    expect((await duda.call('GET', '/api/team/members')).statusCode).toBe(200);
  });

  it('desativar derruba a sessão e impede novo login; reativar volta', async () => {
    const id = await createDuda();
    const duda = await loginAs(DUDA.email, DUDA.password);
    expect((await duda.call('GET', '/api/conversations')).statusCode).toBe(200);
    expect((await admin.call('PATCH', `/api/team/${id}`, { active: false })).statusCode).toBe(200);
    expect((await duda.call('GET', '/api/conversations')).statusCode).toBe(401);
    expect((await loginAs(DUDA.email, DUDA.password)).res.statusCode).toBe(403);
    await admin.call('PATCH', `/api/team/${id}`, { active: true });
    expect((await loginAs(DUDA.email, DUDA.password)).res.statusCode).toBe(200);
  });

  it('nova senha pelo admin derruba as sessões e vale no próximo login', async () => {
    const id = await createDuda();
    const duda = await loginAs(DUDA.email, DUDA.password);
    expect((await admin.call('PATCH', `/api/team/${id}`, { password: 'Outra-Senha-99' })).statusCode).toBe(200);
    expect((await duda.call('GET', '/api/conversations')).statusCode).toBe(401);
    expect((await loginAs(DUDA.email, DUDA.password)).res.statusCode).toBe(401);
    expect((await loginAs(DUDA.email, 'Outra-Senha-99')).res.statusCode).toBe(200);
  });

  it('sempre sobra um administrador ativo e ninguém se rebaixa', async () => {
    const me = (await admin.call('GET', '/api/auth/status')).json().user;
    expect((await admin.call('PATCH', `/api/team/${me.id}`, { active: false })).statusCode).toBe(400);
    expect((await admin.call('PATCH', `/api/team/${me.id}`, { role: 'ATENDENTE' })).statusCode).toBe(400);
    const id = await createDuda();
    await admin.call('PATCH', `/api/team/${id}`, { role: 'ADMIN' });
    const duda = await loginAs(DUDA.email, DUDA.password);
    // agora há dois admins: a Duda pode rebaixar o primeiro
    expect((await duda.call('PATCH', `/api/team/${me.id}`, { role: 'ATENDENTE' })).statusCode).toBe(200);
    // e não pode mais sair a última administradora
    expect((await duda.call('PATCH', `/api/team/${id}`, { role: 'ATENDENTE' })).statusCode).toBe(400);
  });
});

describe('conversa com responsável', () => {
  async function clientWrites(text: string) {
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5511988887777', text, name: 'Maria' }));
    await ctx.bus.drain();
    return ctx.db.conversation.findFirstOrThrow();
  }

  it('quem responde vira responsável e assina a mensagem; não tira de quem já está', async () => {
    await seedNumber(ctx.db);
    const dudaId = await createDuda();
    const duda = await loginAs(DUDA.email, DUDA.password);
    const conv = await clientWrites('Oi');

    expect((await duda.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Oi Maria, aqui é a Duda' })).statusCode).toBe(201);
    let c = (await admin.call('GET', `/api/conversations/${conv.id}`)).json().conversation;
    expect(c.assignedTo).toEqual({ id: dudaId, name: 'Duda' });

    // o admin responde também: a conversa continua com a Duda, mas a mensagem sai com o nome dele
    await admin.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Complementando' });
    c = (await admin.call('GET', `/api/conversations/${conv.id}`)).json().conversation;
    expect(c.assignedTo.id).toBe(dudaId);
    const msgs = (await admin.call('GET', `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(msgs.filter((m: { sentBy: string }) => m.sentBy === 'HUMAN').map((m: { sentByName: string }) => m.sentByName)).toEqual(['Duda', 'oliver']);

    const mine = (await duda.call('GET', '/api/conversations?filter=mine')).json();
    expect(mine.conversations).toHaveLength(1);
    expect(mine.counts.mine).toBe(1);
    expect((await admin.call('GET', '/api/conversations?filter=mine')).json().conversations).toHaveLength(0);
  });

  it('passar para outra pessoa, tirar responsável e desativar devolve para a fila', async () => {
    await seedNumber(ctx.db);
    const dudaId = await createDuda();
    const conv = await clientWrites('Oi');
    const res = await admin.call('POST', `/api/conversations/${conv.id}/assign`, { userId: dudaId });
    expect(res.json().conversation.assignedTo.name).toBe('Duda');
    expect((await admin.call('POST', `/api/conversations/${conv.id}/assign`, { userId: 'nao-existe' })).statusCode).toBe(400);
    await admin.call('PATCH', `/api/team/${dudaId}`, { active: false });
    expect((await ctx.db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).assignedToId).toBeNull();
  });
});
