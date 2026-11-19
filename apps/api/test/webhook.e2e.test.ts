import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeWamid, inboundTextPayload, qualityPayload, statusPayload } from '../src/dev/payloads.js';
import { sendTemplateMessage, sendTextMessage } from '../src/messaging/outbound.js';
import { ServiceWindowClosedError } from '../src/messaging/window.js';
import { createTestContext, PNID, resetDb, seedNumber, TEST_VERIFY, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
const CLIENT = '5511988887777';

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

function textFromClient(text: string, id?: string) {
  return inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: CLIENT, name: 'Maria Souza', text, id });
}

describe('GET /webhook (verificação da Meta)', () => {
  it('devolve o challenge com o verify token correto', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY}&hub.challenge=12345`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });
  it('recusa verify token errado', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhook', () => {
  it('recusa assinatura inválida sem gravar nada', async () => {
    const res = await ctx.postWebhook(textFromClient('Oi'), { secret: 'segredo-errado' });
    expect(res.statusCode).toBe(401);
    expect(await ctx.db.webhookEvent.count()).toBe(0);
  });

  it('recebe uma mensagem, registra contato/conversa/mensagem e responde (echo)', async () => {
    await seedNumber(ctx.db);
    const res = await ctx.postWebhook(textFromClient('Oi, tem perfume árabe doce?'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1, queued: 1 });
    await ctx.bus.drain();

    const contact = await ctx.db.contact.findUniqueOrThrow({ where: { phone: `+${CLIENT}` } });
    expect(contact.name).toBe('Maria Souza');
    expect(contact.optIn).toBe(false); // iniciar conversa NÃO é consentimento de marketing

    const conv = await ctx.db.conversation.findFirstOrThrow({ include: { messages: { orderBy: { createdAt: 'asc' } } } });
    expect(conv.handler).toBe('BOT');
    expect(conv.messages.map((m) => [m.direction, m.sentBy])).toEqual([
      ['INBOUND', 'CONTACT'],
      ['OUTBOUND', 'BOT'],
    ]);

    // Resposta saiu pela "Meta" para o número certo, com texto
    expect(ctx.meta.sent).toHaveLength(1);
    expect(ctx.meta.sent[0]?.body).toMatchObject({ to: CLIENT, type: 'text' });
    expect(JSON.stringify(ctx.meta.sent[0]?.body)).toContain('Maria');
    // e a mensagem do cliente foi marcada como lida
    expect(ctx.meta.readReceipts).toHaveLength(1);
  });

  it('é idempotente: o mesmo message.id entregue 3 vezes gera 1 registro e 1 resposta', async () => {
    await seedNumber(ctx.db);
    const id = fakeWamid();
    for (let i = 0; i < 3; i++) {
      const res = await ctx.postWebhook(textFromClient('Oi', id));
      expect(res.statusCode).toBe(200);
    }
    await ctx.bus.drain();
    expect(await ctx.db.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
    expect(await ctx.db.webhookEvent.count()).toBe(1);
    expect(ctx.meta.sent).toHaveLength(1);
  });

  it('atualiza o status da mensagem enviada (sent → delivered → read) sem regredir', async () => {
    await seedNumber(ctx.db);
    await ctx.postWebhook(textFromClient('Oi'));
    await ctx.bus.drain();
    const wamid = ctx.meta.sent[0]!.wamid;

    for (const status of ['sent', 'read', 'delivered'] as const) {
      await ctx.postWebhook(statusPayload({ wabaId: WABA, phoneNumberId: PNID, wamid, status, recipient: CLIENT }));
    }
    await ctx.bus.drain();
    const msg = await ctx.db.message.findUniqueOrThrow({ where: { waMessageId: wamid } });
    expect(msg.status).toBe('READ'); // "delivered" atrasado não rebaixa
    expect(msg.sentAt).not.toBeNull();
    expect(msg.readAt).not.toBeNull();
    expect(msg.deliveredAt).not.toBeNull();
  });

  it('registra falha de entrega com código e motivo', async () => {
    await seedNumber(ctx.db);
    await ctx.postWebhook(textFromClient('Oi'));
    await ctx.bus.drain();
    const wamid = ctx.meta.sent[0]!.wamid;
    await ctx.postWebhook(
      statusPayload({ wabaId: WABA, phoneNumberId: PNID, wamid, status: 'failed', recipient: CLIENT, error: { code: 131047, title: 'Re-engagement message' } }),
    );
    await ctx.bus.drain();
    const msg = await ctx.db.message.findUniqueOrThrow({ where: { waMessageId: wamid } });
    expect(msg.status).toBe('FAILED');
    expect(msg.errorCode).toBe('131047');
  });

  it('opt-out: "SAIR" marca o contato, registra consentimento e confirma', async () => {
    await seedNumber(ctx.db);
    await ctx.db.contact.create({ data: { phone: `+${CLIENT}`, optIn: true, optInAt: new Date(), optInSource: 'csv' } });
    await ctx.postWebhook(textFromClient('SAIR'));
    await ctx.bus.drain();

    const c = await ctx.db.contact.findUniqueOrThrow({ where: { phone: `+${CLIENT}` }, include: { consentLogs: true } });
    expect(c.optOut).toBe(true);
    expect(c.optOutAt).not.toBeNull();
    expect(c.consentLogs.map((l) => l.action)).toEqual(['OPT_OUT']);
    expect(ctx.meta.sent).toHaveLength(1);
    expect(JSON.stringify(ctx.meta.sent[0]?.body)).toContain('VOLTAR');
    const outbound = await ctx.db.message.findFirstOrThrow({ where: { direction: 'OUTBOUND' } });
    expect(outbound.sentBy).toBe('SYSTEM');
  });

  it('conversa com HUMANO: só registra, o bot não responde', async () => {
    const number = await seedNumber(ctx.db);
    const contact = await ctx.db.contact.create({ data: { phone: `+${CLIENT}` } });
    await ctx.db.conversation.create({ data: { contactId: contact.id, phoneNumberId: number.id, handler: 'HUMAN' } });
    await ctx.postWebhook(textFromClient('Oi, ainda está aí?'));
    await ctx.bus.drain();
    expect(await ctx.db.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
    expect(ctx.meta.sent).toHaveLength(0);
  });

  it('bot desligado no número: só registra', async () => {
    await seedNumber(ctx.db, { botEnabled: false });
    await ctx.postWebhook(textFromClient('Oi'));
    await ctx.bus.drain();
    expect(await ctx.db.message.count()).toBe(1);
    expect(ctx.meta.sent).toHaveLength(0);
  });

  it('qualidade BAIXA: pausa campanhas do número e cria alerta crítico', async () => {
    const number = await seedNumber(ctx.db);
    ctx.meta.numberInfo = { quality_rating: 'RED', messaging_limit_tier: 'TIER_1K' };
    await ctx.postWebhook(qualityPayload({ wabaId: WABA, displayPhone: '15550001111', event: 'FLAGGED', currentLimit: 'TIER_1K' }));
    await ctx.bus.drain();
    const n = await ctx.db.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(n.qualityRating).toBe('LOW');
    expect(n.campaignsPaused).toBe(true);
    expect(n.dailyConversationLimit).toBe(1000);
    const alert = await ctx.db.alert.findFirstOrThrow();
    expect(alert.level).toBe('CRITICAL');
  });
});

describe('regra da janela de 24h no envio', () => {
  it('bloqueia texto livre fora da janela, mas permite template', async () => {
    const number = await seedNumber(ctx.db);
    const contact = await ctx.db.contact.create({ data: { phone: `+${CLIENT}` } });
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    const conv = await ctx.db.conversation.create({ data: { contactId: contact.id, phoneNumberId: number.id, lastInboundAt: old } });

    await expect(sendTextMessage(ctx.deps, { conversationId: conv.id, body: 'Oi!', sentBy: 'HUMAN' })).rejects.toBeInstanceOf(
      ServiceWindowClosedError,
    );
    expect(ctx.meta.sent).toHaveLength(0);

    await sendTemplateMessage(ctx.deps, { conversationId: conv.id, name: 'boas_vindas', language: 'pt_BR', sentBy: 'HUMAN' });
    expect(ctx.meta.sent).toHaveLength(1);
    expect(ctx.meta.sent[0]?.body).toMatchObject({ type: 'template', template: { name: 'boas_vindas' } });
  });

  it('marca a mensagem como FAILED quando a Meta recusa o envio', async () => {
    const number = await seedNumber(ctx.db);
    const contact = await ctx.db.contact.create({ data: { phone: `+${CLIENT}` } });
    const conv = await ctx.db.conversation.create({ data: { contactId: contact.id, phoneNumberId: number.id, lastInboundAt: new Date() } });
    ctx.meta.failNext = { status: 400, code: 131026, message: 'Message undeliverable' };
    await expect(sendTextMessage(ctx.deps, { conversationId: conv.id, body: 'Oi!', sentBy: 'HUMAN' })).rejects.toThrow('undeliverable');
    const msg = await ctx.db.message.findFirstOrThrow();
    expect(msg.status).toBe('FAILED');
    expect(msg.errorCode).toBe('131026');
  });
});

describe('GET /health', () => {
  it('reporta banco e fila', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: true, queue: true, queueDriver: 'memory' });
  });
});
