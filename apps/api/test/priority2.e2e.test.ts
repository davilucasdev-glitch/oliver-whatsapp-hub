import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, spDate } from '../src/charges/config.js';
import { RELATION_INFO, RELATION_KINDS } from '../src/relation/service.js';
import { SUPPLIER_INFO } from '../src/suppliers/service.js';
import { pdfSafe } from '../src/suppliers/pdf.js';
import { ALERT_INFO, ALERT_KINDS, orderList, runTeamAlerts } from '../src/team/alerts.js';
import { connectBling, createTestContext, loginAsAdmin, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAsAdmin>>;

beforeAll(async () => {
  ctx = await createTestContext({ META_APP_ID: 'TEST_APP' });
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

async function approved(name: string, body: string, examples: string[], category = 'UTILITY', header?: 'DOCUMENT') {
  await ctx.db.template.create({
    data: {
      wabaId: WABA,
      name,
      language: 'pt_BR',
      category,
      status: 'APPROVED',
      components: [...(header ? [{ type: 'HEADER', format: 'DOCUMENT' }] : []), { type: 'BODY', text: body, example: { body_text: [examples] } }],
    },
  });
}
const lastSent = () => ctx.meta.sent.at(-1)?.body as { to: string; template: { name: string; components: { type: string; parameters: { type: string; text?: string; document?: { id: string; filename: string } }[] }[] } };
const bodyParams = () => lastSent().template.components.find((c) => c.type === 'body')?.parameters.map((p) => p.text);
const me = async () => (await admin.call('GET', '/api/auth/status')).json().user.id as string;

/** "10:00 de hoje em Brasília" */
const spAt = (hour: number) => new Date(`${spDate()}T${String(hour + 3).padStart(2, '0')}:00:00Z`);

describe('avisos para a equipe', () => {
  async function setupTeam(flags: Record<string, boolean>) {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    for (const k of ALERT_KINDS) await approved(ALERT_INFO[k].suggested.name, ALERT_INFO[k].suggested.body, ALERT_INFO[k].suggested.examples);
    const res = await admin.call('PATCH', `/api/team/${await me()}`, { phone: '(63) 99214-2094', ...flags });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('lista de pedidos só com número e primeiro nome', () => {
    expect(orderList([{ numero: 8814, contactName: 'GISELE DIAS' }, { numero: 8815, contactName: null }])).toBe('nº 8814 (GISELE), nº 8815');
    expect(orderList(Array.from({ length: 30 }, (_, i) => ({ numero: i, contactName: null })), 25)).toMatch(/e mais 5$/);
  });

  it('WhatsApp inválido é recusado', async () => {
    expect((await admin.call('PATCH', `/api/team/${await me()}`, { phone: '123' })).statusCode).toBe(400);
  });

  it('pedido novo em Separando avisa quem separa, mesmo com os avisos às clientes desligados (e do TikTok também)', async () => {
    await setupTeam({ alertNewOrders: true });
    await admin.call('POST', '/api/order-notices/poll'); // foto inicial
    ctx.bling.updateOrder(8806, { situacaoId: 947772 });
    ctx.bling.updateOrder(8805, { situacaoId: 947772 }); // loja TikTok
    const r = (await admin.call('POST', '/api/order-notices/poll')).json();
    expect(r.teamAlerts).toBe(1);
    expect(lastSent()).toMatchObject({ to: '5563992142094', template: { name: 'equipe_pedidos_separar' } });
    expect(bodyParams()).toEqual(['nº 8805 (Maria), nº 8806 (João)']);
    expect(ctx.meta.sent).toHaveLength(1); // nenhuma mensagem para as clientes
    await admin.call('POST', '/api/order-notices/poll');
    expect(ctx.meta.sent).toHaveLength(1);
  });

  it('pedidos parados há mais de 1 dia: uma vez por dia, depois do horário', async () => {
    await setupTeam({ alertStuck: true });
    await admin.call('POST', '/api/order-notices/poll');
    ctx.bling.updateOrder(8806, { situacaoId: 947773 });
    await admin.call('POST', '/api/order-notices/poll');
    await ctx.db.orderState.updateMany({ where: { numero: 8806 }, data: { situacaoSince: new Date(Date.now() - 48 * 3600_000) } });
    expect((await runTeamAlerts(ctx.deps, { now: spAt(7) })).sent).toBe(0); // antes das 9h
    expect((await runTeamAlerts(ctx.deps, { now: spAt(10) })).sent).toBe(1);
    expect(lastSent().template.name).toBe('equipe_pedidos_parados');
    expect(bodyParams()).toEqual(['nº 8806 (João)']);
    expect((await runTeamAlerts(ctx.deps, { now: spAt(11) })).sent).toBe(0);
  });

  it('resumo do fim do dia: quantos saíram e quantos ficaram', async () => {
    await setupTeam({ alertDaily: true });
    await admin.call('POST', '/api/order-notices/poll');
    ctx.bling.updateOrder(8806, { situacaoId: 947779 }); // enviado hoje
    ctx.bling.addOrder({ numero: 8840, contato: { id: 5001, nome: 'Maria Souza' }, situacao: { id: 947772 } });
    await admin.call('POST', '/api/order-notices/poll');
    ctx.meta.sent.length = 0;
    expect((await runTeamAlerts(ctx.deps, { now: spAt(19) })).sent).toBe(1);
    expect(lastSent().template.name).toBe('equipe_resumo_dia');
    expect(bodyParams()).toEqual(['1', '1', 'nº 8840']);
  });
});

describe('relacionamento (só opt-in)', () => {
  async function setupRel() {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    for (const k of RELATION_KINDS) await approved(RELATION_INFO[k].suggested.name, RELATION_INFO[k].suggested.body, RELATION_INFO[k].suggested.examples, 'MARKETING');
    const today = spDate();
    ctx.bling.contacts.find((c) => c.id === 5001)!.dadosAdicionais = { dataNascimento: `1990-${today.slice(5)}` };
    const maria = await ctx.db.contact.create({ data: { phone: '+5511988887777', name: 'Maria Souza', optIn: true, optInAt: new Date(), optInSource: 'teste' } });
    await ctx.db.contact.create({ data: { phone: '+5521977776666', name: 'João Lima' } }); // sem opt-in
    const { config } = (await admin.call('GET', '/api/relation')).json();
    await admin.call('PUT', '/api/relation/config', { ...config, reviewLink: 'https://g.page/r/oliver/review', birthdayGift: '10% com o cupom NIVER10', restockLink: 'https://blackfridaydaoliver.com' });
    const sync = await admin.call('POST', '/api/relation/sync');
    expect(sync.statusCode, sync.body).toBe(200);
    return maria;
  }

  it('lê aniversário e última compra no Bling e monta as listas', async () => {
    const maria = await setupRel();
    const c = await ctx.db.contact.findUniqueOrThrow({ where: { id: maria.id } });
    expect(c).toMatchObject({ blingContactId: '5001', lastOrderDate: '2026-11-14' });
    expect(c.birthDate).toMatch(/^1990-/);
    const l = (await admin.call('GET', '/api/relation')).json();
    expect(l.aniversario.map((r: { name: string }) => r.name)).toEqual(['Maria Souza']);
    expect(l.aniversario[0].variables).toEqual(['Maria', '10% com o cupom NIVER10']);
    expect(l.stats).toMatchObject({ optInTotal: 1, withBirth: 1, withLastOrder: 1 });
  });

  it('aniversário: um clique, uma vez por ano; opt-out sai da lista', async () => {
    const maria = await setupRel();
    const key = (await admin.call('GET', '/api/relation')).json().aniversario[0].key;
    expect((await admin.call('POST', '/api/relation/send', { key })).json().status).toBe('SENT');
    expect(lastSent()).toMatchObject({ to: '5511988887777', template: { name: 'rel_aniversario' } });
    expect((await admin.call('POST', '/api/relation/send', { key })).statusCode).toBe(409);
    await ctx.db.contact.update({ where: { id: maria.id }, data: { optOut: true } });
    expect((await admin.call('GET', '/api/relation')).json().aniversario).toHaveLength(0);
  });

  it('hora de repor e avaliação 2 dias depois de Atendido', async () => {
    const maria = await setupRel();
    await ctx.db.contact.update({ where: { id: maria.id }, data: { lastOrderDate: addDays(spDate(), -46) } });
    await ctx.db.orderState.create({ data: { blingOrderId: '9001', numero: 8801, lojaId: '206151954', situacaoId: 9, situacaoSince: new Date(Date.now() - 3 * 86_400_000), contactBlingId: '5001', contactName: 'Maria Souza' } });
    await ctx.db.orderState.create({ data: { blingOrderId: '9999', numero: 8899, lojaId: '206151954', situacaoId: 9, situacaoSince: new Date(Date.now() - 1 * 86_400_000), contactBlingId: '5001', contactName: 'Maria Souza' } });
    const l = (await admin.call('GET', '/api/relation')).json();
    expect(l.recompra.map((r: { name: string }) => r.name)).toEqual(['Maria Souza']);
    expect(l.avaliacao.map((r: { variables: string[] }) => r.variables)).toEqual([['Maria', '8801', 'https://g.page/r/oliver/review']]); // o de ontem ainda não
    const many = (await admin.call('POST', '/api/relation/send-many', { keys: [l.recompra[0].key, l.avaliacao[0].key] })).json();
    expect(many.sent).toBe(2);
  });
});

describe('fornecedores', () => {
  it('texto do PDF só com caracteres que a fonte desenha', () => {
    expect(pdfSafe('Cotação — “Oliver” • 100ml\n😀')).toBe('Cotação - "Oliver" - 100ml ');
  });

  it('lista os pedidos de compra com o fornecedor e gera o PDF com a logo', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    const s = (await admin.call('GET', '/api/suppliers')).json();
    expect(s.orders.map((o: { numero: number; supplier: { phone: string | null } }) => [o.numero, o.supplier.phone])).toEqual([
      [191, '+5545991040157'],
      [190, null],
    ]);
    const pdf = await admin.call('GET', `/api/suppliers/purchase-orders/9501/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.length).toBeGreaterThan(20_000); // tem a logo
  });

  it('cria os templates com PDF no cabeçalho (exemplo pelo upload retomável)', async () => {
    await seedNumber(ctx.db);
    const r = (await admin.call('POST', '/api/suppliers/templates')).json();
    expect(r.results.map((x: { status: string; error?: string }) => x.error ?? x.status)).toEqual(['PENDING', 'PENDING']);
    expect(ctx.meta.sampleUploads).toBe(1);
    const t = ctx.meta.templates.find((x) => x.name === 'compra_pedido')!;
    expect(t.components[0]).toMatchObject({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [expect.stringMatching(/^HANDLE-/)] } });
  });

  it('envia o pedido de compra em PDF: fornecedor marcado e conversa com a responsável', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await approved('compra_pedido', SUPPLIER_INFO.PEDIDO_COMPRA.suggested.body, SUPPLIER_INFO.PEDIDO_COMPRA.suggested.examples, 'UTILITY', 'DOCUMENT');
    const ellen = (await admin.call('POST', '/api/team', { name: 'Ellen', email: 'ellen@exemplo.com.br', role: 'ATENDENTE', password: 'Ellen-Senha-2026' })).json().user.id;
    const { config } = (await admin.call('GET', '/api/suppliers')).json();
    await admin.call('PUT', '/api/suppliers/config', { ...config, ownerUserId: ellen });

    const r = await admin.call('POST', '/api/suppliers/purchase-orders/9501/send');
    expect(r.json(), r.body).toMatchObject({ status: 'SENT' });
    const header = lastSent().template.components.find((c) => c.type === 'header')!;
    expect(header.parameters[0]).toMatchObject({ type: 'document', document: { filename: 'Pedido de compra 191 - Oliver Cosmeticos.pdf' } });
    expect(ctx.meta.media.get(header.parameters[0]!.document!.id)?.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bodyParams()).toEqual(['Beauty Mania', '191', 'R$ 1.013,66']);
    const contact = await ctx.db.contact.findUniqueOrThrow({ where: { phone: '+5545991040157' } });
    expect(contact).toMatchObject({ isSupplier: true, blingContactId: '5010' });
    const conv = await ctx.db.conversation.findUniqueOrThrow({ where: { id: r.json().conversationId } });
    expect(conv.assignedToId).toBe(ellen);
    // fornecedor sem telefone
    expect((await admin.call('POST', '/api/suppliers/purchase-orders/9502/send')).statusCode).toBe(400);
    const list = (await admin.call('GET', '/api/suppliers')).json();
    expect(list.orders[0].lastSend).toMatchObject({ status: 'SENT' });
  });

  it('cotação: PDF enviado pela tela para um fornecedor do Bling', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await approved('compra_cotacao', SUPPLIER_INFO.COTACAO.suggested.body, SUPPLIER_INFO.COTACAO.suggested.examples, 'UTILITY', 'DOCUMENT');
    const boundary = '----oliver';
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = (file: Buffer) =>
      Buffer.concat([
        Buffer.from(part('supplierBlingId', '5010')),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cotacao.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const send = (file: Buffer) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/suppliers/quote',
        headers: { cookie: `oh_session=${admin.cookie.value}`, 'x-oliver-panel': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body(file),
      });
    expect((await send(Buffer.from('não é pdf'))).statusCode).toBe(400);
    const ok = await send(Buffer.from('%PDF-1.4\n%fake\n'));
    expect(ok.json(), ok.body).toMatchObject({ status: 'SENT' });
    expect(lastSent()).toMatchObject({ to: '5545991040157', template: { name: 'compra_cotacao' } });
    expect(bodyParams()).toEqual(['Beauty Mania']);
  });
});
