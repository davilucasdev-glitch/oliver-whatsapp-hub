import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BlingClient, BlingNotConnectedError } from '../src/bling/client.js';
import { lookupOrdersForCustomer } from '../src/bling/orders.js';
import { searchProducts } from '../src/bling/products.js';
import { syncProducts } from '../src/bling/sync.js';
import { decrypt } from '../src/lib/crypto.js';
import { createTestContext, loginAsAdmin, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
let call: Awaited<ReturnType<typeof loginAsAdmin>>['call'];

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.bling.reset();
  ({ call } = await loginAsAdmin(ctx.app));
});

/** Faz o caminho do navegador: painel → Bling (aprova) → callback da API. */
async function connect() {
  const res = await call('POST', '/api/bling/connect');
  expect(res.statusCode).toBe(200);
  const authorize = await fetch(res.json<{ url: string }>().url, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location')!);
  expect(back.pathname).toBe('/api/bling/callback');
  const cb = await ctx.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
  await ctx.bus.drain(); // a conexão dispara o primeiro sync
  return cb;
}

const fastClient = () => new BlingClient(ctx.deps, { backoffMs: 1, sleep: () => Promise.resolve() });

describe('OAuth do Bling', () => {
  it('conecta, guarda os tokens criptografados e já sincroniza', async () => {
    const cb = await connect();
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:3000/produtos?bling=conectado');

    const auth = await ctx.db.blingAuth.findUniqueOrThrow({ where: { id: 'default' } });
    expect(auth.accessTokenEnc).not.toContain(ctx.bling.accessToken!);
    expect(decrypt(auth.accessTokenEnc, ctx.env.ENCRYPTION_KEY)).toBe(ctx.bling.accessToken);
    expect(decrypt(auth.refreshTokenEnc, ctx.env.ENCRYPTION_KEY)).toBe(ctx.bling.refreshToken);

    const status = (await call('GET', '/api/bling/status')).json();
    expect(status).toMatchObject({ configured: true, connected: true, sync: { ok: true, trigger: 'conexao' }, products: { active: 5 } });
  });

  it('recusa state inválido, reaproveitado ou expirado', async () => {
    await call('POST', '/api/bling/connect');
    const forged = await ctx.app.inject({ method: 'GET', url: '/api/bling/callback?code=x&state=forjado' });
    expect(forged.headers.location).toContain('bling=erro');

    await connect();
    // mesmo state de novo (uso único)
    const res = await call('POST', '/api/bling/connect');
    const state = new URL(res.json<{ url: string }>().url).searchParams.get('state')!;
    await ctx.app.inject({ method: 'GET', url: `/api/bling/callback?error=access_denied&state=${state}` });
    const again = await ctx.app.inject({ method: 'GET', url: `/api/bling/callback?code=x&state=${state}` });
    expect(new URL(again.headers.location as string).searchParams.get('motivo')).toContain('inválido ou expirado');
  });

  it('cancelamento no Bling volta com mensagem', async () => {
    const res = await call('POST', '/api/bling/connect');
    const state = new URL(res.json<{ url: string }>().url).searchParams.get('state')!;
    const cb = await ctx.app.inject({ method: 'GET', url: `/api/bling/callback?error=access_denied&state=${state}` });
    expect(decodeURIComponent((cb.headers.location as string).replace(/\+/g, ' '))).toContain('cancelada');
    expect(await ctx.db.blingAuth.count()).toBe(0);
  });

  it('renova o token perto do vencimento e grava o novo refresh_token', async () => {
    await connect();
    const oldRefresh = ctx.bling.refreshToken;
    await ctx.db.blingAuth.update({ where: { id: 'default' }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    await fastClient().get('/produtos/1001');
    expect(ctx.bling.refreshToken).not.toBe(oldRefresh);
    const auth = await ctx.db.blingAuth.findUniqueOrThrow({ where: { id: 'default' } });
    expect(decrypt(auth.refreshTokenEnc, ctx.env.ENCRYPTION_KEY)).toBe(ctx.bling.refreshToken);
    expect(auth.lastRefreshAt).not.toBeNull();
  });

  it('renova uma vez só com várias chamadas simultâneas', async () => {
    await connect();
    await ctx.db.blingAuth.update({ where: { id: 'default' }, data: { expiresAt: new Date(Date.now() + 1000) } });
    const client = fastClient();
    await Promise.all([client.get('/produtos/1001'), client.get('/produtos/1002'), client.get('/produtos/1003')]);
    // se renovasse 3 vezes, as duas últimas usariam refresh_token já girado e falhariam
    expect(await ctx.db.blingAuth.count()).toBe(1);
  });

  it('401 inesperado → renova e repete a chamada', async () => {
    await connect();
    ctx.bling.expireAccessToken();
    const r = await fastClient().get<{ data: { id: number } }>('/produtos/1001');
    expect(r.data.id).toBe(1001);
  });

  it('refresh recusado → desconecta e cria alerta crítico', async () => {
    await connect();
    ctx.bling.expireAccessToken();
    ctx.bling.rejectRefresh = true;
    await expect(fastClient().get('/produtos/1001')).rejects.toBeInstanceOf(BlingNotConnectedError);
    expect(await ctx.db.blingAuth.count()).toBe(0);
    const alert = await ctx.db.alert.findFirstOrThrow({ where: { type: 'BLING_DISCONNECTED' } });
    expect(alert.level).toBe('CRITICAL');
  });

  it('429 e 5xx → espera e tenta de novo (backoff)', async () => {
    await connect();
    const waits: number[] = [];
    const client = new BlingClient(ctx.deps, { backoffMs: 10, sleep: async (ms) => void waits.push(ms) });
    ctx.bling.failNext = { status: 429, times: 2 };
    const r = await client.get<{ data: { id: number } }>('/produtos/1002');
    expect(r.data.id).toBe(1002);
    expect(waits.filter((w) => w >= 10)).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!); // exponencial

    ctx.bling.failNext = { status: 503, times: 10 };
    await expect(client.get('/produtos/1002')).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('desconectar apaga os tokens', async () => {
    await connect();
    await call('POST', '/api/bling/disconnect');
    expect(await ctx.db.blingAuth.count()).toBe(0);
    const sync = await call('POST', '/api/bling/sync', {});
    expect(sync.statusCode).toBe(409);
  });
});

describe('Sync de produtos', () => {
  it('importa ativos com descrição limpa, categoria, gênero e estoque', async () => {
    await connect();
    const asad = await ctx.db.product.findUniqueOrThrow({ where: { blingId: '1001' } });
    expect(asad).toMatchObject({ name: 'LATTAFA ASAD EDP 100ML', sku: 'LAT-ASAD', category: 'Perfumaria > Árabes', gender: 'masculino', active: true });
    expect(Number(asad.price)).toBe(189.9);
    expect(Number(asad.stock)).toBe(7);
    expect(asad.descriptionText).toContain('• Notas de Fundo: baunilha, âmbar, benjoim');
    expect(asad.descriptionText).not.toContain('<');
    expect(asad.shortDescription).toBe('Masculino intenso e ambarado, com pimenta preta e baunilha. Ótimo para a noite.');

    // sem descricaoCurta → usa a complementar
    const cupcake = await ctx.db.product.findUniqueOrThrow({ where: { blingId: '1004' } });
    expect(cupcake.descriptionText).toBe('Body splash feminino de morango & chantilly.');
    expect(cupcake.gender).toBe('feminino');
    // inativo no Bling não entra
    expect(await ctx.db.product.findUnique({ where: { blingId: '1006' } })).toBeNull();
  });

  it('incremental: só busca o detalhe do que mudou; tira de linha o que sumiu', async () => {
    await connect();
    ctx.bling.calls.length = 0;
    const second = await syncProducts(ctx.deps, { client: fastClient() });
    expect(second).toMatchObject({ details: 0, updated: 0, created: 0 });
    // descrição que só existe na "complementar" (lida no detalhe) continua lá
    const cupcake = await ctx.db.product.findUniqueOrThrow({ where: { blingId: '1004' } });
    expect(cupcake.descriptionText).toBe('Body splash feminino de morango & chantilly.');
    expect(ctx.bling.calls.filter((c) => c.startsWith('GET /Api/v3/produtos/'))).toHaveLength(0);

    const yara = ctx.bling.products.find((p) => p.id === 1002)!;
    yara.preco = 159.9;
    yara.estoque = { saldoVirtualTotal: 4 };
    ctx.bling.products.find((p) => p.id === 1005)!.situacao = 'I';
    const third = await syncProducts(ctx.deps, { client: fastClient() });
    expect(third).toMatchObject({ details: 1, updated: 1, deactivated: 1, created: 0 });
    const y = await ctx.db.product.findUniqueOrThrow({ where: { blingId: '1002' } });
    expect([Number(y.price), Number(y.stock)]).toEqual([159.9, 4]);
    expect((await ctx.db.product.findUniqueOrThrow({ where: { blingId: '1005' } })).active).toBe(false);
  });

  it('falha no meio não marca nada como inativo e grava o erro no status', async () => {
    await connect();
    ctx.bling.failNext = { status: 500, times: 50 };
    await expect(syncProducts(ctx.deps, { client: fastClient() })).rejects.toThrow();
    expect(await ctx.db.product.count({ where: { active: true } })).toBe(5);
    const status = (await call('GET', '/api/bling/status')).json();
    expect(status.sync).toMatchObject({ ok: false, running: false });
    expect(status.sync.error).toContain('Falha no sync');
  });

  it('sync manual pelo painel', async () => {
    await connect();
    const res = await call('POST', '/api/bling/sync', { full: true });
    expect(res.statusCode).toBe(200);
    await ctx.bus.drain();
    const status = (await call('GET', '/api/bling/status')).json();
    expect(status.sync).toMatchObject({ ok: true, trigger: 'manual', result: { details: 5 } });
  });
});

describe('Busca de produtos', () => {
  beforeEach(async () => {
    await connect();
  });

  it('acha sem acento, por código e tolera erro de digitação', async () => {
    const names = async (query: string) => (await searchProducts(ctx.db, { query })).products.map((p) => p.name);
    expect((await names('lattafa'))[0]).toMatch(/LATTAFA|Lattafa/);
    expect(await names('arabes')).toEqual(expect.arrayContaining(['LATTAFA ASAD EDP 100ML', 'LATTAFA YARA EDP 100ML FEM']));
    expect((await names('lataffa asad'))[0]).toBe('LATTAFA ASAD EDP 100ML');
    expect(await names('icon100')).toEqual(['AB THE ICON ELIXIR EDP MASC 100ML']);
    expect((await names('baunilha'))).toContain('LATTAFA YARA EDP 100ML FEM');
    expect(await names('xyzxyz')).toEqual([]);
  });

  it('filtra por estoque, gênero e categoria pelo painel', async () => {
    const inStock = (await call('GET', '/api/products?q=lattafa&inStock=true')).json();
    expect(inStock.products.map((p: { blingId: string }) => p.blingId)).not.toContain('1002');
    const fem = (await call('GET', '/api/products?gender=feminino')).json();
    expect(fem.products.every((p: { gender: string }) => p.gender === 'feminino')).toBe(true);
    const kits = (await call('GET', '/api/products?category=Kits')).json();
    expect(kits.total).toBe(1);
    const cats = (await call('GET', '/api/products/categories')).json();
    expect(cats.categories).toContainEqual({ category: 'Perfumaria > Árabes', count: 2 });
    const one = (await call('GET', `/api/products/${kits.products[0].id}`)).json();
    expect(one.product).toMatchObject({ format: 'E', price: 145 });
    expect(one.product.searchText).toBeUndefined();
  });
});

describe('Pedidos e contatos', () => {
  beforeEach(async () => {
    await connect();
  });

  const maria = { phone: '+5511988887777' };

  it('lista pedidos do próprio cliente pelo telefone, com situação e rastreio', async () => {
    const r = await lookupOrdersForCustomer(ctx.deps, maria, null, fastClient());
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.orders.map((o) => o.numero)).toEqual([8805, 8801]);
    expect(r.orders[0]).toMatchObject({ situacao: 'Aguardando envio', dataSaida: null, dataPrevista: '2026-11-20', rastreios: [] });
    expect(r.orders[1]).toMatchObject({ situacao: 'Atendido', transportadora: 'Correios', rastreios: ['AB123456789BR'], notaFiscalEmitida: true });
    expect(r.orders[1]!.itens).toHaveLength(2);
  });

  it('pedido pelo número só sai para o dono (CPF ou telefone)', async () => {
    const own = await lookupOrdersForCustomer(ctx.deps, maria, 8801, fastClient());
    expect(own.status).toBe('found');
    // outro cliente perguntando pelo pedido da Maria
    const stranger = await lookupOrdersForCustomer(ctx.deps, { phone: '+5531911112222' }, 8801, fastClient());
    expect(stranger.status).toBe('needs_document');
    const wrongDoc = await lookupOrdersForCustomer(ctx.deps, { phone: '+5531911112222', document: '111.444.777-35' }, 8801, fastClient());
    expect(wrongDoc.status).toBe('not_owner');
    const byDoc = await lookupOrdersForCustomer(ctx.deps, { phone: '+5531911112222', document: '52998224725' }, 8801, fastClient());
    expect(byDoc.status).toBe('found');
    expect((await lookupOrdersForCustomer(ctx.deps, maria, 99999, fastClient())).status).toBe('not_found');
  });

  it('sem cadastro pelo telefone pede o CPF', async () => {
    const r = await lookupOrdersForCustomer(ctx.deps, { phone: '+5531911112222' }, null, fastClient());
    expect(r.status).toBe('needs_document');
    const byDoc = await lookupOrdersForCustomer(ctx.deps, { phone: '+5531911112222', document: '111.444.777-35' }, null, fastClient());
    expect(byDoc.status).toBe('found');
  });

  it('ficha do contato: vincula ao Bling, completa dados vazios e mostra pedidos', async () => {
    const contact = await ctx.db.contact.create({ data: { phone: '+5511988887777' } });
    const res = await call('GET', `/api/contacts/${contact.id}/bling`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ linked: true, blingContact: { id: '5001', nome: 'Maria Souza' } });
    expect(body.orders).toHaveLength(2);
    const updated = await ctx.db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(updated).toMatchObject({ blingContactId: '5001', name: 'Maria Souza', email: 'maria@exemplo.com', document: '52998224725' });

    const unknown = await ctx.db.contact.create({ data: { phone: '+5531911112222', name: 'Fulana' } });
    const none = (await call('GET', `/api/contacts/${unknown.id}/bling`)).json();
    expect(none).toMatchObject({ linked: false, orders: [] });
    expect(none.hint).toContain('CPF');
  });

  it('sem conexão a ficha avisa para conectar', async () => {
    await call('POST', '/api/bling/disconnect');
    const contact = await ctx.db.contact.create({ data: { phone: '+5511988887777' } });
    const res = await call('GET', `/api/contacts/${contact.id}/bling`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('não está conectado');
  });
});
