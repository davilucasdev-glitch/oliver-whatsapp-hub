import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlingOrderDetail } from '../src/bling/types.js';
import { KIND_INFO, ORDER_KINDS, situationsByName } from '../src/orders/config.js';
import { blingDateTime, decideKind, firstName, isPickup, serviceName } from '../src/orders/engine.js';
import { connectBling, createTestContext, loginAsAdmin, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

const order = (o: Partial<BlingOrderDetail>): BlingOrderDetail =>
  ({ id: 1, numero: 1, data: '2026-11-18', total: 10, contato: { id: 1, nome: 'x' }, situacao: { id: 6 }, ...o }) as BlingOrderDetail;

describe('regras dos avisos de pedido', () => {
  it('retirada × envio pelas observações e pelo rastreio', () => {
    const pickup = order({ observacoes: 'Pedido pelo site Black Friday · ATACADO · Retirar na loja · Pix' });
    const ship = order({ observacoes: 'Pedido pelo site · Entrega · Pix', transporte: { volumes: [{ servico: 'PAC CONTRATO AG', codigoRastreamento: 'AP761097925BR' }] } });
    const shipNoCode = order({ observacoes: 'Entrega' });
    expect(isPickup(pickup)).toBe(true);
    expect(isPickup(ship)).toBe(false);
    expect(decideKind('ETIQUETA', pickup)).toEqual({ kind: 'PRONTO_RETIRAR' });
    expect(decideKind('ETIQUETA', ship)).toBeNull();
    expect(decideKind('ENVIADO', ship)).toEqual({ kind: 'ENVIADO' });
    expect(decideKind('ENVIADO', pickup)).toEqual({ kind: 'PRONTO_RETIRAR' });
    expect(decideKind('ENVIADO', shipNoCode)?.wait).toMatch(/sem código de rastreio/);
    expect(serviceName(ship)).toBe('PAC');
    expect(serviceName(order({ transporte: { volumes: [{ servico: 'SEDEX 10 CONTRATO' }] } }))).toBe('SEDEX 10');
  });

  it('primeiro nome, data no fuso de Brasília e situações pelo nome', () => {
    expect(firstName('MARIA EDUARDA')).toBe('Maria');
    expect(firstName('  ')).toBe('cliente');
    expect(blingDateTime(new Date('2026-11-18T15:04:05Z'))).toBe('2026-11-18 12:04:05');
    const s = situationsByName([
      { id: 6, nome: 'Em aberto' },
      { id: 947772, nome: 'Separando' },
      { id: 947773, nome: 'Emitir Etiqueta' },
      { id: 947779, nome: 'Enviado' },
      { id: 9, nome: 'Atendido' },
    ]);
    expect(s).toMatchObject({ ABERTO: [6], SEPARANDO: [947772], ETIQUETA: [947773], ENVIADO: [947779], ATENDIDO: [9], CANCELADO: [12] });
  });

  it('textos sugeridos: não começam nem terminam com variável e têm um exemplo por variável', () => {
    for (const k of ORDER_KINDS) {
      const { body, examples } = KIND_INFO[k].suggested;
      expect(body.trim()).not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}[.!]?$/);
      expect((body.match(/\{\{\d+\}\}/g) ?? []).length).toBe(examples.length);
      expect(examples.length).toBe(KIND_INFO[k].vars.length);
    }
  });
});

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

/** Templates sugeridos já aprovados (como depois da Meta aprovar). */
async function approvedTemplates() {
  for (const k of ORDER_KINDS) {
    const s = KIND_INFO[k].suggested;
    await ctx.db.template.create({
      data: {
        wabaId: WABA,
        name: s.name,
        language: 'pt_BR',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: s.body, example: { body_text: [s.examples] } }],
      },
    });
  }
}

async function setup(overrides: Record<string, unknown> = {}) {
  await seedNumber(ctx.db);
  await connectBling(ctx, admin.call);
  await approvedTemplates();
  const { config } = (await admin.call('GET', '/api/order-notices')).json();
  const res = await admin.call('PUT', '/api/order-notices', { ...config, enabled: true, storeInfo: 'Rua das Flores, 100 · seg a sáb, 9h às 18h', ...overrides });
  expect(res.statusCode, res.body).toBe(200);
}

const poll = async () => (await admin.call('POST', '/api/order-notices/poll')).json();
const lastTemplate = () => {
  const b = ctx.meta.sent.at(-1)?.body as { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } } | undefined;
  return b ? { to: b.to, name: b.template.name, params: b.template.components[0]?.parameters.map((p) => p.text) } : null;
};
const notice = (numero: number, kind: string) => ctx.db.orderNotice.findFirst({ where: { orderNumber: numero, kind: kind as never } });

describe('avisos de pedido (Bling → WhatsApp)', () => {
  it('configuração: situações achadas pelo nome e TikTok sempre fora', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    const data = (await admin.call('GET', '/api/order-notices')).json();
    expect(data.config.enabled).toBe(false);
    expect(data.config.situations).toMatchObject({ SEPARANDO: [947772], ETIQUETA: [947773], ENVIADO: [947779] });
    expect(data.config.excludedStores).toContain('206093178');
    const res = await admin.call('PUT', '/api/order-notices', { ...data.config, excludedStores: [] });
    expect(res.json().config.excludedStores).toContain('206093178');
  });

  it('primeira rodada só fotografa; depois avisa cada mudança uma vez só', async () => {
    await setup();
    const first = await poll();
    expect(first.baseline).toBe(3);
    expect(ctx.meta.sent).toHaveLength(0);

    // João (8806, Em aberto) vai para Separando no Kanban
    ctx.bling.updateOrder(8806, { situacaoId: 947772 });
    const r = await poll();
    expect(r.sent).toBe(1);
    expect(lastTemplate()).toEqual({ to: '5521977776666', name: 'pedido_separando', params: ['João', '8806'] });

    // nada mudou: nada sai
    await poll();
    expect(ctx.meta.sent).toHaveLength(1);

    // volta para Em aberto e de novo para Separando: não reenvia nem manda "recebemos"
    ctx.bling.updateOrder(8806, { situacaoId: 6 });
    await poll();
    ctx.bling.updateOrder(8806, { situacaoId: 947772 });
    await poll();
    expect(ctx.meta.sent).toHaveLength(1);

    // a mensagem aparece na inbox como do sistema
    const msg = await ctx.db.message.findFirstOrThrow({ where: { templateName: 'pedido_separando' } });
    expect(msg.sentBy).toBe('SYSTEM');
  });

  it('pedido do site com retirada: recebido → pronto para retirar → entregue, pelo WhatsApp das observações', async () => {
    await setup();
    await poll();
    ctx.bling.addOrder({
      numero: 8830,
      total: 474,
      loja: { id: 206151954 },
      contato: { id: 5003, nome: 'MARIA EDUARDA' },
      observacoes: 'Pedido pelo site Black Friday · ATACADO · Retirar na loja · Cartão de crédito',
      observacoesInternas: 'Site blackfridaydaoliver.com · WhatsApp 62992229004 · pedido 8fb4ec8d37',
      parcelas: [{ valor: 474, formaPagamento: { id: 8238338 } }],
    });
    await poll();
    expect(lastTemplate()).toEqual({ to: '5562992229004', name: 'pedido_recebido', params: ['Maria', '8830', 'R$ 474,00', 'Cartão de crédito'] });

    ctx.bling.updateOrder(8830, { situacaoId: 947773 });
    await poll();
    expect(lastTemplate()?.name).toBe('pedido_pronto_retirada');
    expect(lastTemplate()?.params?.[2]).toBe('Rua das Flores, 100 · seg a sáb, 9h às 18h');

    // marcado como Enviado (sem rastreio, é retirada): não manda "saiu"
    ctx.bling.updateOrder(8830, { situacaoId: 947779 });
    await poll();
    expect(ctx.meta.sent).toHaveLength(2);

    ctx.bling.updateOrder(8830, { situacaoId: 9 });
    await poll();
    expect(lastTemplate()?.name).toBe('pedido_entregue');
    expect(ctx.meta.sent).toHaveLength(3);
  });

  it('envio: espera o código de rastreio e manda com serviço e link', async () => {
    await setup();
    await poll();
    ctx.bling.addOrder({ numero: 8832, loja: { id: 206151954 }, contato: { id: 5001, nome: 'Maria Souza' }, observacoes: 'Entrega', situacao: { id: 947779 } });
    await poll();
    expect(ctx.meta.sent).toHaveLength(0);
    expect(await notice(8832, 'ENVIADO')).toMatchObject({ status: 'SKIPPED' });

    // a etiqueta foi emitida: o código entra no pedido (sem mudar a situação)
    ctx.bling.updateOrder(8832, { transporte: { volumes: [{ servico: 'PAC CONTRATO AG', codigoRastreamento: 'AP761097925BR' }] } });
    await poll();
    expect(lastTemplate()).toEqual({
      to: '5511988887777',
      name: 'pedido_enviado',
      params: ['Maria', '8832', 'PAC', 'AP761097925BR', 'https://rastreamento.correios.com.br/app/index.php?objetos=AP761097925BR'],
    });
    expect(await notice(8832, 'ENVIADO')).toMatchObject({ status: 'SENT', phone: '+5511988887777' });
  });

  it('venda de balcão direto em Atendido, TikTok e pedido sem telefone não recebem aviso', async () => {
    await setup();
    await poll();
    ctx.bling.addOrder({ numero: 8831, loja: { id: 205798284 }, contato: { id: 5001, nome: 'Maria Souza' }, situacao: { id: 9 } });
    ctx.bling.updateOrder(8805, { situacaoId: 947772 }); // loja TikTok
    ctx.bling.addOrder({ numero: 8833, loja: { id: 206151954 }, contato: { id: 5003, nome: 'ANA PAULA SILVA' } });
    const r = await poll();
    expect(r.sent).toBe(0);
    expect(ctx.meta.sent).toHaveLength(0);
    expect(await notice(8831, 'ENTREGUE')).toBeNull();
    expect(await notice(8805, 'SEPARANDO')).toBeNull();
    expect((await notice(8833, 'RECEBIDO'))?.reason).toMatch(/sem telefone/);
  });

  it('modo de teste manda para o número de teste e registra o telefone da cliente', async () => {
    await setup({ testPhone: '(63) 99214-2094' });
    await poll();
    ctx.bling.updateOrder(8806, { situacaoId: 947772 });
    await poll();
    expect(lastTemplate()?.to).toBe('5563992142094');
    expect(await notice(8806, 'SEPARANDO')).toMatchObject({ status: 'SENT', phone: '+5521977776666', sentTo: '+5563992142094' });
    // a ficha do número de teste não ganha o nome da cliente
    expect((await ctx.db.contact.findUniqueOrThrow({ where: { phone: '+5563992142094' } })).name).toBeNull();
  });

  it('template ainda não aprovado vira "pulado" com o motivo; erro da Meta fica registrado', async () => {
    await setup();
    await poll();
    await ctx.db.template.updateMany({ where: { name: 'pedido_separando' }, data: { status: 'PENDING' } });
    ctx.bling.updateOrder(8806, { situacaoId: 947772 });
    await poll();
    expect((await notice(8806, 'SEPARANDO'))?.reason).toMatch(/não está aprovado/);

    ctx.meta.failNext = { status: 400, code: 131026, message: 'Message undeliverable' };
    ctx.bling.addOrder({ numero: 8834, loja: { id: 206151954 }, contato: { id: 5001, nome: 'Maria Souza' } });
    await poll();
    expect(await notice(8834, 'RECEBIDO')).toMatchObject({ status: 'FAILED' });
  });

  it('desligado não lê nada; teste manual manda só para o número de teste', async () => {
    await seedNumber(ctx.db);
    await connectBling(ctx, admin.call);
    await approvedTemplates();
    expect((await poll()).reason).toMatch(/desligados/);

    const sem = await admin.call('POST', '/api/order-notices/test', { kind: 'SEPARANDO', orderNumber: 8806 });
    expect(sem.statusCode).toBe(400);
    const { config } = (await admin.call('GET', '/api/order-notices')).json();
    await admin.call('PUT', '/api/order-notices', { ...config, testPhone: '63992142094' });
    const ok = await admin.call('POST', '/api/order-notices/test', { kind: 'SEPARANDO', orderNumber: 8806 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ sentTo: '+5563992142094', variables: ['João', '8806'], customerPhone: '+5521977776666' });
    expect(await ctx.db.orderNotice.count()).toBe(0);
  });

  it('cria os templates sugeridos na Meta (categoria Utilidade, sem botão de sair)', async () => {
    await seedNumber(ctx.db);
    const res = await admin.call('POST', '/api/order-notices/templates');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(Array(6).fill('PENDING'));
    const created = ctx.meta.templates.filter((t) => t.name.startsWith('pedido_'));
    expect(created).toHaveLength(6);
    expect(created.every((t) => t.category === 'UTILITY')).toBe(true);
    // de novo: não duplica
    const again = (await admin.call('POST', '/api/order-notices/templates')).json();
    expect(again.results.every((r: { status: string }) => r.status === 'PENDING')).toBe(true);
    expect(ctx.meta.templates.filter((t) => t.name.startsWith('pedido_'))).toHaveLength(6);
  });
});
