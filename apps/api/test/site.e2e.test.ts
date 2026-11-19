import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inboundTextPayload, statusPayload } from '../src/dev/payloads.js';
import { CAMPAIGN_TEMPLATE } from '../src/http/integration-routes.js';
import { RELATION_INFO } from '../src/relation/service.js';
import { createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAsAdmin>>;
let siteSrv: FastifyInstance;
let siteUrl = '';
const received: { headers: Record<string, unknown>; raw: string }[] = [];

beforeAll(async () => {
  ctx = await createTestContext({ META_APP_ID: 'TEST_APP' });
  // "site" de mentira que recebe os avisos do hub
  siteSrv = Fastify();
  siteSrv.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  siteSrv.post('/webhook-oliver', async (req) => {
    received.push({ headers: req.headers, raw: req.body as string });
    return { ok: true };
  });
  siteUrl = await siteSrv.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await siteSrv.close();
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.meta.reset();
  received.length = 0;
  admin = await loginAsAdmin(ctx.app);
});

async function token() {
  return (await admin.call('POST', '/api/integration/token')).json().token as string;
}
const site = (t: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/site/v1${url}`, headers: { authorization: `Bearer ${t}` }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function approved(name: string, body: string, examples: string[], category = 'UTILITY', header?: 'DOCUMENT' | 'IMAGE') {
  await ctx.db.template.create({
    data: { wabaId: WABA, name, language: 'pt_BR', category, status: 'APPROVED', components: [...(header ? [{ type: 'HEADER', format: header }] : []), { type: 'BODY', text: body, example: { body_text: [examples] } }] },
  });
}
const lastSent = () => ctx.meta.sent.at(-1)?.body as { to: string; template: { name: string; components: { type: string; parameters: { type: string; text?: string; document?: { id?: string }; image?: { link?: string } }[] }[] } };

describe('API para o site: chave', () => {
  it('sem chave, chave errada ou chave antiga não entram', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/site/v1/ping' })).statusCode).toBe(401);
    const t1 = await token();
    expect((await site(t1, 'GET', '/ping')).statusCode).toBe(200);
    expect((await site('oh_site_errada', 'GET', '/ping')).statusCode).toBe(401);
    const t2 = await token();
    expect((await site(t1, 'GET', '/ping')).statusCode).toBe(401);
    expect((await site(t2, 'GET', '/ping')).statusCode).toBe(200);
    // a chave nunca volta na tela (só o começo)
    const info = (await admin.call('GET', '/api/integration')).json();
    expect(info.token.prefix).toBe(t2.slice(0, 12));
    expect(JSON.stringify(info)).not.toContain(t2);
  });
});

describe('API para o site: envio', () => {
  it('envia template aprovado; mesmo ref não manda de novo; erros claros', async () => {
    await seedNumber(ctx.db);
    await approved('pedido_separando', 'Oi, {{1}}! Seu pedido nº {{2}} está sendo separado.', ['Maria', '1']);
    const t = await token();
    const tpls = (await site(t, 'GET', '/templates')).json().templates;
    expect(tpls.find((x: { name: string }) => x.name === 'pedido_separando')).toMatchObject({ variables: 2, attachment: null, status: 'APPROVED' });

    const ok = await site(t, 'POST', '/messages', { phone: '63992142094', template: 'pedido_separando', variables: ['Gisele', '8814'], ref: 'pedido-8814-separando' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'SENT', duplicate: false });
    expect(lastSent()).toMatchObject({ to: '5563992142094', template: { name: 'pedido_separando' } });
    const again = await site(t, 'POST', '/messages', { phone: '63992142094', template: 'pedido_separando', variables: ['Gisele', '8814'], ref: 'pedido-8814-separando' });
    expect(again.json()).toMatchObject({ duplicate: true });
    expect(ctx.meta.sent).toHaveLength(1);

    expect((await site(t, 'POST', '/messages', { phone: '123', template: 'pedido_separando', variables: [] })).statusCode).toBe(400);
    expect((await site(t, 'POST', '/messages', { phone: '63992142094', template: 'nao_existe', variables: [] })).json().error).toMatch(/não existe/);
  });

  it('marketing sem opt-in falha com o motivo; PDF do cabeçalho vai pela Meta', async () => {
    await seedNumber(ctx.db);
    await approved('promo_teste', 'Oi, {{1}}! Novidades.', ['Maria'], 'MARKETING');
    await approved('extrato_pdf', 'Oi, {{1}}! Segue o seu extrato.', ['Maria'], 'UTILITY', 'DOCUMENT');
    const t = await token();
    const mk = await site(t, 'POST', '/messages', { phone: '63992142094', template: 'promo_teste', variables: ['Gisele'] });
    expect(mk.statusCode).toBe(422);
    expect(mk.json().error).toMatch(/opt-in/);

    const sem = await site(t, 'POST', '/messages', { phone: '63992142094', template: 'extrato_pdf', variables: ['Gisele'] });
    expect(sem.statusCode).toBe(400);
    const pdf = Buffer.from('%PDF-1.4\n%extrato\n').toString('base64');
    const com = await site(t, 'POST', '/messages', { phone: '63992142094', template: 'extrato_pdf', variables: ['Gisele'], attachment: { base64: pdf, filename: 'extrato.pdf' } });
    expect(com.json(), com.body).toMatchObject({ status: 'SENT' });
    const header = lastSent().template.components.find((c) => c.type === 'header')!;
    expect(ctx.meta.media.get(header.parameters[0]!.document!.id!)?.data.toString()).toContain('%PDF');
  });
});

describe('API para o site: consentimento', () => {
  it('opt-in do site guarda quando e como; quem saiu não volta pelo site; lista de opt-out', async () => {
    await seedNumber(ctx.db);
    const t = await token();
    const r = await site(t, 'POST', '/opt-in', { phone: '63992142094', name: 'Gisele', source: 'checkout-black-friday', at: '2026-11-18T12:00:00Z' });
    expect(r.json()).toMatchObject({ optIn: true });
    const c = await ctx.db.contact.findUniqueOrThrow({ where: { phone: '+5563992142094' }, include: { consentLogs: true } });
    expect(c).toMatchObject({ optIn: true, optInSource: 'site:checkout-black-friday' });
    expect(c.optInAt?.toISOString()).toBe('2026-11-18T12:00:00.000Z');
    expect(c.consentLogs).toHaveLength(1);

    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5563992142094', text: 'SAIR', name: 'Gisele' }));
    await ctx.bus.drain();
    const outs = (await site(t, 'GET', '/opt-outs')).json().optOuts;
    expect(outs.map((o: { phone: string }) => o.phone)).toEqual(['+5563992142094']);
    expect((await site(t, 'POST', '/opt-in', { phone: '63992142094', source: 'checkout' })).json()).toMatchObject({ optIn: false });
  });
});

describe('avisos do hub para o site', () => {
  it('mensagem recebida, status do envio (com o ref) e opt-out chegam assinados', async () => {
    await seedNumber(ctx.db);
    await approved('pedido_separando', 'Oi, {{1}}! Seu pedido nº {{2}} está sendo separado.', ['Maria', '1']);
    const t = await token();
    const put = (await admin.call('PUT', '/api/integration/webhook', { url: `${siteUrl}/webhook-oliver` })).json();
    expect(put.secret).toBeTruthy();
    const secret = put.secret as string;

    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5563992142094', text: 'Segue o comprovante', name: 'Gisele' }));
    await ctx.bus.drain();
    const send = (await site(t, 'POST', '/messages', { phone: '63992142094', template: 'pedido_separando', variables: ['Gisele', '8814'], ref: 'p-8814' })).json();
    const wamid = ctx.meta.sent.find((m) => (m.body as { type: string }).type === 'template')!.wamid;
    await ctx.postWebhook(statusPayload({ wabaId: WABA, phoneNumberId: PNID, wamid, status: 'delivered', recipient: '5563992142094' }));
    await ctx.bus.drain();
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: '5563992142094', text: 'SAIR', name: 'Gisele' }));
    await ctx.bus.drain();

    const events = received.map((r) => JSON.parse(r.raw) as { event: string; data: Record<string, unknown> });
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['message.received', 'message.status', 'contact.opt_out']));
    expect(events.find((e) => e.event === 'message.received')!.data).toMatchObject({ phone: '+5563992142094', text: 'Segue o comprovante', name: 'Gisele' });
    expect(events.find((e) => e.event === 'message.status')!.data).toMatchObject({ ref: 'p-8814', status: 'delivered', messageId: send.messageId });
    for (const r of received) {
      expect(r.headers['x-oliver-signature']).toBe(`sha256=${createHmac('sha256', secret).update(r.raw).digest('hex')}`);
    }
    const logs = (await admin.call('GET', '/api/integration')).json().logs;
    expect(logs.every((l: { ok: boolean }) => l.ok)).toBe(true);
  });
});

describe('carrinho parado', () => {
  it('o site avisa; depois de 1 h aparece para quem tem opt-in; some quando vira pedido', async () => {
    await seedNumber(ctx.db);
    const s = RELATION_INFO.CARRINHO.suggested;
    await approved(s.name, s.body, s.examples, 'MARKETING');
    await ctx.db.contact.create({ data: { phone: '+5563992142094', name: 'Gisele', optIn: true, optInAt: new Date() } });
    const t = await token();
    const r = await site(t, 'POST', '/carts', { ref: 'cart-1', phone: '63992142094', name: 'Gisele', items: [{ name: 'Lattafa Asad 100ml', qty: 1 }, { name: 'Yara 100ml', qty: 2 }], total: 389.8, link: 'https://blackfridaydaoliver.com/carrinho/1' });
    expect(r.statusCode, r.body).toBe(201);
    expect((await admin.call('GET', '/api/relation')).json().carrinho).toHaveLength(0); // ainda não passou 1 h
    await ctx.db.abandonedCart.updateMany({ data: { updatedAt: new Date(Date.now() - 2 * 3600_000) } });
    const list = (await admin.call('GET', '/api/relation')).json().carrinho;
    expect(list[0].variables).toEqual(['Gisele', 'Lattafa Asad 100ml e 2x Yara 100ml', 'https://blackfridaydaoliver.com/carrinho/1']);
    await site(t, 'POST', '/carts/cart-1/recovered');
    expect((await admin.call('GET', '/api/relation')).json().carrinho).toHaveLength(0);
  });
});

describe('campanha vinda do painel', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

  it('cria rascunho com a arte e o público (varejo); só administrador aprova', async () => {
    await ctx.db.phoneNumber.create({ data: { phoneNumberId: PNID, wabaId: WABA, displayName: 'Oliver', status: 'CONNECTED', qualityRating: 'HIGH', role: 'BOTH' } });
    await approved('campanha_arte', CAMPAIGN_TEMPLATE.body, CAMPAIGN_TEMPLATE.examples, 'MARKETING', 'IMAGE');
    await ctx.db.contact.create({ data: { phone: '+5563992142094', name: 'Gisele', optIn: true, optInAt: new Date() } });
    const t = await token();
    const r = await site(t, 'POST', '/campaigns', {
      name: 'Chegou: novidades da semana',
      text: 'Chegaram as novidades e reposições da semana, com preço de varejo especial.',
      segment: 'varejo',
      phones: ['63992142094', '11988887777', '123'],
      image: { base64: png.toString('base64'), mime: 'image/png' },
      ref: 'arte-2026-11-18',
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ status: 'DRAFT', invalidPhones: 1, audience: { total: 2, eligible: 1 } });
    const c = await ctx.db.campaign.findUniqueOrThrow({ where: { id: body.campaignId } });
    expect(c).toMatchObject({ source: 'painel', status: 'DRAFT' });
    const artPath = new URL(c.headerMediaUrl!).pathname;
    const art = await ctx.app.inject({ method: 'GET', url: artPath });
    expect(art.statusCode).toBe(200);
    expect(art.headers['content-type']).toBe('image/png');
    expect(await ctx.db.tag.findUnique({ where: { name: 'Varejo' } })).not.toBeNull();
    // o mesmo ref não cria outra
    expect((await site(t, 'POST', '/campaigns', { name: 'Outra', text: 'texto qualquer', segment: 'varejo', phones: ['63992142094'], image: { url: 'https://exemplo.com/a.jpg' }, ref: 'arte-2026-11-18' })).json()).toMatchObject({ duplicate: true });

    await admin.call('POST', '/api/team', { name: 'Duda', email: 'duda@exemplo.com.br', role: 'ATENDENTE', password: 'Duda-Senha-2026' });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'duda@exemplo.com.br', password: 'Duda-Senha-2026' } });
    const cookie = login.cookies.find((k) => k.name === 'oh_session')!;
    const duda = await ctx.app.inject({ method: 'POST', url: `/api/campaigns/${c.id}/start`, headers: { cookie: `oh_session=${cookie.value}`, 'x-oliver-panel': '1' } });
    expect(duda.statusCode).toBe(403);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/start`)).statusCode).toBe(200);
  });

  it('cria o template da campanha com a imagem de exemplo e o botão Quero', async () => {
    await seedNumber(ctx.db);
    const r = await admin.call('POST', '/api/integration/campaign-template');
    expect(r.json(), r.body).toMatchObject({ name: 'campanha_arte', status: 'PENDING' });
    const t = ctx.meta.templates.find((x) => x.name === 'campanha_arte')!;
    expect(t.category).toBe('MARKETING');
    expect(t.components[0]).toMatchObject({ type: 'HEADER', format: 'IMAGE' });
    expect(JSON.stringify(t.components)).toContain('Quero');
    expect(JSON.stringify(t.components)).toContain('Parar promoções');
  });
});
