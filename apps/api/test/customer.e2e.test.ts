import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inboundTextPayload } from '../src/dev/payloads.js';
import { connectBling, createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

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

async function clientWrites(from: string, name: string) {
  await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from, text: 'Oi, cadê meu pedido?', name }));
  await ctx.bus.drain();
  return ctx.db.conversation.findFirstOrThrow({ where: { contact: { phone: `+${from}` } } });
}
const customer = async (convId: string, q = '') => (await admin.call('GET', `/api/conversations/${convId}/customer${q}`)).json();

describe('ficha da cliente na inbox', () => {
  it('acha a cliente pelo telefone no Bling: pedidos, pedido em andamento e crediário', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await admin.call('POST', '/api/charges/sync');
    const conv = await clientWrites('5511988887777', 'Mari');
    const c = await customer(conv.id);
    expect(c.bling).toMatchObject({ id: '5001', nome: 'Maria Souza' });
    expect(c.contact.blingContactId).toBe('5001');
    expect(c.orders.map((o: { numero: number }) => o.numero)).toEqual([8805, 8801]);
    expect(c.openOrder).toMatchObject({ numero: 8805, situacao: 'Aguardando envio' });
    // crediário: TikTok e conta antes do corte ficam fora (mesmas regras da Cobrança)
    expect(c.credit).toMatchObject({ balance: 756, balanceKnown: true, overdue: 200 });
    expect(c.credit.parcels).toHaveLength(3);
  });

  it('pedidos ficam guardados 2 minutos (não consulta o Bling a cada abertura)', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    const conv = await clientWrites('5521977776666', 'João');
    await customer(conv.id);
    const before = ctx.bling.calls.filter((c) => c.startsWith('GET /Api/v3/pedidos')).length;
    await customer(conv.id);
    expect(ctx.bling.calls.filter((c) => c.startsWith('GET /Api/v3/pedidos')).length).toBe(before);
    await customer(conv.id, '?refresh=1');
    expect(ctx.bling.calls.filter((c) => c.startsWith('GET /Api/v3/pedidos')).length).toBeGreaterThan(before);
  });

  it('vincula pelo telefone das contas a receber sem procurar no cadastro', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await admin.call('POST', '/api/charges/sync');
    const conv = await clientWrites('5521977776666', 'Joao');
    ctx.bling.calls.length = 0;
    const c = await customer(conv.id);
    expect(c.contact.blingContactId).toBe('5002');
    expect(ctx.bling.calls).not.toContain('GET /Api/v3/contatos');
  });

  it('número sem cadastro no Bling e Bling desconectado não quebram a conversa', async () => {
    await seedNumber(ctx.db);
    const off = await clientWrites('5511900000099', 'Fulana');
    expect(await customer(off.id)).toMatchObject({ connected: false, bling: null, orders: [], credit: null });
    await connectBling(ctx, admin.call);
    const c = await customer(off.id);
    expect(c).toMatchObject({ connected: true, bling: null, blingError: null });
    expect(c.hint).toMatch(/Nenhum cadastro/);
  });

  it('link do Kanban precisa de {numero}', async () => {
    expect((await admin.call('PUT', '/api/inbox/kanban-url', { url: 'https://painel.exemplo.com/kanban.php' })).statusCode).toBe(400);
    expect((await admin.call('PUT', '/api/inbox/kanban-url', { url: 'https://painel.exemplo.com/kanban.php?pedido={numero}' })).statusCode).toBe(200);
    await seedNumber(ctx.db);
    const conv = await clientWrites('5511900000099', 'Fulana');
    expect((await customer(conv.id)).kanbanUrl).toBe('https://painel.exemplo.com/kanban.php?pedido={numero}');
  });
});
