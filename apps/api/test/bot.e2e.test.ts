import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAILED_ATTEMPTS_MESSAGE, FALLBACK_ERROR_MESSAGE } from '../src/bot/engine.js';
import { startMockClaude, type MockClaude } from '../src/dev/mock-claude.js';
import { inboundTextPayload } from '../src/dev/payloads.js';
import { setSetting, SETTINGS } from '../src/settings.js';
import { connectBling, createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
let claude: MockClaude;
let call: Awaited<ReturnType<typeof loginAsAdmin>>['call'];

const MARIA = '5511988887777'; // cliente com pedidos no Bling simulado
const OTHER = '5531911112222';
const ALWAYS_OPEN = { timezone: 'America/Sao_Paulo', days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ['00:00', '23:59']])), closedDates: [] };
const ALWAYS_CLOSED = { timezone: 'America/Sao_Paulo', days: {}, closedDates: [] };

beforeAll(async () => {
  claude = await startMockClaude();
  ctx = await createTestContext({
    BOT_MODE: 'ai',
    ANTHROPIC_API_KEY: 'sk-ant-teste-00000000000000000000',
    ANTHROPIC_BASE_URL: claude.url,
    BOT_DEBOUNCE_MS: '0',
  });
});
afterAll(async () => {
  await ctx.close();
  await claude.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  ctx.meta.reset();
  ctx.bling.reset();
  claude.reset();
  ({ call } = await loginAsAdmin(ctx.app));
  await seedNumber(ctx.db);
  await connectBling(ctx, call);
  await setSetting(ctx.db, SETTINGS.businessHours, ALWAYS_OPEN);
});

async function say(text: string, from = MARIA, name = 'Maria Souza') {
  await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from, text, name }));
  await ctx.bus.drain();
}

const texts = () => ctx.meta.sent.filter((s) => s.body.type === 'text').map((s) => (s.body.text as { body: string }).body);
const conversation = (phone = `+${MARIA}`) => ctx.db.conversation.findFirstOrThrow({ where: { contact: { phone } } });

describe('Bot de IA no WhatsApp', () => {
  it('busca no catálogo e responde só com produtos e preços reais', async () => {
    await say('Tem perfume da Lattafa?');
    const reply = texts().at(-1)!;
    expect(reply).toContain('LATTAFA ASAD EDP 100ML');
    expect(reply).toContain('R$ 189,90');
    expect(reply).toContain('inspirado em Sauvage Elixir (Dior)');
    // Yara está sem estoque: a busca do bot não traz
    expect(reply).not.toContain('YARA');
    expect(claude.violations).toEqual([]);

    // 2 chamadas: uma pediu a ferramenta, a outra respondeu. A 2ª devolveu o thinking sem alteração.
    expect(claude.requests).toHaveLength(2);
    const second = claude.requests[1]!.body as { messages: { role: string; content: unknown }[]; output_config: unknown; model: string };
    expect(second.model).toBe('claude-sonnet-5-5');
    expect(second.output_config).toEqual({ effort: 'low' });
    expect(JSON.stringify(second.messages.at(-2))).toContain('"type":"thinking"');

    const log = await ctx.db.botLog.findFirstOrThrow({ where: { conversationId: (await conversation()).id } });
    expect(log).toMatchObject({ simulated: false, iterations: 2, handoff: false, error: null, model: 'claude-sonnet-5-5' });
    expect(log.inputTokens).toBeGreaterThan(0);
    expect(log.cacheReadTokens + log.cacheWriteTokens).toBeGreaterThan(0);
    expect(log.toolsCalled).toMatchObject([{ name: 'buscar_produtos', ok: true, outcome: 'ok' }]);
  });

  it('envia a foto do produto antes do texto', async () => {
    await say('me manda a foto do asad');
    const kinds = ctx.meta.sent.map((s) => s.body.type);
    expect(kinds).toEqual(['image', 'text']);
    const img = ctx.meta.sent[0]!.body.image as { link: string; caption: string };
    expect(img.link).toContain('/img/1001.svg?full=1'); // link novo buscado no Bling na hora
    expect(img.caption).toBe('LATTAFA ASAD EDP 100ML — R$ 189,90');
  });

  it('consulta o pedido do próprio cliente', async () => {
    await say('qual o status do meu pedido 8801?');
    expect(texts().at(-1)).toBe('Seu pedido *8801* está como *Atendido*. Rastreio: AB123456789BR');
  });

  it('não mostra pedido de outra pessoa', async () => {
    await say('qual o status do pedido 8801?', OTHER, 'Fulana');
    const reply = texts().at(-1)!;
    expect(reply).not.toContain('Atendido');
    expect(reply).toContain('CPF');
  });

  it('pedido de atendente → transfere, avisa o cliente e o painel; depois o bot fica quieto', async () => {
    await say('quero falar com um atendente');
    expect(texts().at(-1)).toBe('Prontinho! Um atendente vai continuar com você em instantes 💜');
    const conv = await conversation();
    expect(conv).toMatchObject({ handler: 'HUMAN', handoffReason: 'cliente pediu atendimento humano', awaitingReply: true });
    expect(await ctx.db.alert.count({ where: { type: 'HANDOFF' } })).toBe(1);

    const before = ctx.meta.sent.length;
    await say('alô?');
    expect(ctx.meta.sent.length).toBe(before);
  });

  it('fora do horário avisa quando a equipe volta', async () => {
    await setSetting(ctx.db, SETTINGS.businessHours, ALWAYS_CLOSED);
    await say('quero falar com um atendente');
    expect(texts().at(-1)).toContain('fora do horário');
    const system = JSON.stringify((claude.requests[0]!.body as { system: unknown }).system);
    expect(system).toContain('Atendimento humano: FECHADO agora');
  });

  it('mensagens seguidas geram uma resposta só, com as duas no contexto', async () => {
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: MARIA, text: 'oi', name: 'Maria' }));
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: MARIA, text: 'tem perfume da Lattafa?', name: 'Maria' }));
    await ctx.bus.drain();
    expect(texts()).toHaveLength(1);
    expect(JSON.stringify((claude.requests[0]!.body as { messages: unknown }).messages)).toContain('oi\\ntem perfume da Lattafa?');
  });

  it('2 tentativas sem resolver → transfere para humano', async () => {
    await say('vocês têm xyzabc?');
    expect((await conversation()).botFailedAttempts).toBe(1);
    await say('e qwerty?');
    const conv = await conversation();
    expect(conv.handler).toBe('HUMAN');
    expect(conv.handoffReason).toBe('2 tentativas sem resolver');
    expect(texts().at(-1)).toContain(FAILED_ATTEMPTS_MESSAGE);
  });

  it('acerto zera o contador de tentativas', async () => {
    await say('vocês têm xyzabc?');
    await say('tem perfume da Lattafa?');
    expect((await conversation()).botFailedAttempts).toBe(0);
  });

  it('erro da API → mensagem educada, transfere e alerta', async () => {
    claude.failNext = { status: 400, times: 5 };
    await say('oi tudo bem');
    expect(texts().at(-1)).toBe(FALLBACK_ERROR_MESSAGE);
    expect((await conversation()).handler).toBe('HUMAN');
    expect(await ctx.db.alert.count({ where: { type: 'BOT_ERROR', level: 'CRITICAL' } })).toBe(1);
    const log = await ctx.db.botLog.findFirstOrThrow();
    expect(log.error).toBeTruthy();
  });

  it('bot desligado no número → não responde', async () => {
    await ctx.db.phoneNumber.updateMany({ data: { botEnabled: false } });
    await say('oi');
    expect(ctx.meta.sent).toHaveLength(0);
    expect(claude.requests).toHaveLength(0);
  });

  it('conversa longa: resume as mensagens antigas e manda só as 20 últimas', async () => {
    await say('oi');
    const conv = await conversation();
    const base = Date.now() - 3600_000;
    await ctx.db.message.createMany({
      data: Array.from({ length: 34 }, (_, i) => ({
        conversationId: conv.id,
        phoneNumberId: conv.phoneNumberId,
        direction: i % 2 ? ('OUTBOUND' as const) : ('INBOUND' as const),
        type: 'text',
        body: `mensagem antiga ${i}`,
        status: i % 2 ? ('SENT' as const) : ('RECEIVED' as const),
        sentBy: i % 2 ? ('BOT' as const) : ('CONTACT' as const),
        createdAt: new Date(base + i * 1000),
      })),
    });
    claude.reset();
    await say('tem perfume da Lattafa?');
    const first = JSON.stringify((claude.requests[0]!.body as { messages: unknown }).messages);
    expect(first).not.toContain('mensagem antiga 0');
    const summaryCall = claude.requests.find((r) => !(r.body as { tools?: unknown }).tools);
    expect(summaryCall).toBeTruthy();
    const after = await conversation();
    expect(after.summary).toContain('Resumo (simulado)');
    expect(after.summaryUpToId).toBeTruthy();
  });
});

describe('Painel do bot', () => {
  it('simulador: conversa, consulta pedido com o telefone informado e transfere', async () => {
    const created = await call('POST', '/api/bot/sim/sessions', { customerName: 'Teste', phone: '(11) 98888-7777' });
    expect(created.statusCode).toBe(200);
    const id = created.json().session.id;

    const r1 = (await call('POST', `/api/bot/sim/sessions/${id}/messages`, { text: 'tem perfume da Lattafa?' })).json();
    expect(r1.session.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(r1.session.messages.at(-1).text).toContain('LATTAFA ASAD');
    expect(r1.turn.tools[0].name).toBe('buscar_produtos');
    expect(r1.session.logs).toHaveLength(1);
    expect(ctx.meta.sent).toHaveLength(0); // nada vai para o WhatsApp

    const r2 = (await call('POST', `/api/bot/sim/sessions/${id}/messages`, { text: 'e o meu pedido 8805?' })).json();
    expect(r2.session.messages.at(-1).text).toContain('Aguardando envio');

    const r3 = (await call('POST', `/api/bot/sim/sessions/${id}/messages`, { text: 'quero falar com atendente', forceClosed: true })).json();
    expect(r3.session.handedOff).toBe(true);
    expect(r3.session.messages.at(-1).text).toContain('fora do horário');

    // transferido: o bot não responde mais até "devolver ao bot"
    const r4 = (await call('POST', `/api/bot/sim/sessions/${id}/messages`, { text: 'oi?' })).json();
    expect(r4.turn).toBeNull();
    const released = (await call('POST', `/api/bot/sim/sessions/${id}/release`)).json();
    expect(released.session.handedOff).toBe(false);

    const logs = (await call('GET', '/api/bot/logs?simulated=true')).json();
    expect(logs.total).toBe(3);
    expect(logs.last30Days.replies).toBe(3);
  });

  it('base de conhecimento: começa pelo arquivo, edita, lista pendências e vai para o prompt', async () => {
    const k0 = (await call('GET', '/api/bot/knowledge')).json();
    expect(k0.source).toBe('arquivo');
    expect(k0.content).toContain('CNPJ 50.067.419/0001-39');
    expect(k0.pending.length).toBeGreaterThan(3);

    const edited = `${k0.content}\n## Frete\nFrete grátis acima de R$ 299 para todo o Brasil.`;
    const put = await call('PUT', '/api/bot/knowledge', { content: edited, note: 'frete grátis' });
    expect(put.statusCode).toBe(200);
    const k1 = (await call('GET', '/api/bot/knowledge')).json();
    expect(k1.source).toBe('painel');
    expect(k1.versions[0].note).toBe('frete grátis');

    await say('oi tudo bem');
    expect(JSON.stringify((claude.requests[0]!.body as { system: unknown }).system)).toContain('Frete grátis acima de R$ 299');

    await call('POST', '/api/bot/knowledge/restore-file');
    const k2 = (await call('GET', '/api/bot/knowledge')).json();
    expect(k2.content).not.toContain('Frete grátis');
    expect(k2.versions).toHaveLength(2);
  });

  it('configurações: chave da Anthropic criptografada, horário e tentativas', async () => {
    const bad = await call('PUT', '/api/bot/settings', { anthropicApiKey: 'chave-errada' });
    expect(bad.statusCode).toBe(400);
    const ok = await call('PUT', '/api/bot/settings', { anthropicApiKey: 'sk-ant-api03-painel-123456789012345678901234', maxFailedAttempts: 3, businessHours: ALWAYS_CLOSED });
    expect(ok.statusCode).toBe(200);
    const s = (await call('GET', '/api/bot/settings')).json();
    expect(s.apiKey).toEqual({ configured: true, source: 'painel', last4: '1234' });
    expect(s).toMatchObject({ maxFailedAttempts: 3, humanOpenNow: false, model: 'claude-sonnet-5-5', mode: 'ai' });
    const stored = await ctx.db.setting.findUniqueOrThrow({ where: { key: 'anthropic.apiKeyEnc' } });
    expect(JSON.stringify(stored.value)).not.toContain('sk-ant-api03');

    // a chave do painel é a que vai para a API
    await say('oi tudo bem');
    expect(claude.requests.length).toBeGreaterThan(0);
    await call('PUT', '/api/bot/settings', { anthropicApiKey: null });
    expect((await call('GET', '/api/bot/settings')).json().apiKey.source).toBe('env');
  });
});

describe('Bot sem chave configurada', () => {
  let bare: TestContext;
  beforeAll(async () => {
    bare = await createTestContext({ BOT_MODE: 'ai', BOT_DEBOUNCE_MS: '0', ANTHROPIC_API_KEY: '' });
  });
  afterAll(async () => {
    await bare.close();
  });

  it('passa para a equipe e alerta no painel', async () => {
    await resetDb(bare.db);
    await seedNumber(bare.db);
    await bare.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: MARIA, text: 'oi', name: 'Maria' }));
    await bare.bus.drain();
    const sent = bare.meta.sent.map((s) => (s.body.text as { body: string } | undefined)?.body);
    expect(sent).toEqual([FALLBACK_ERROR_MESSAGE]);
    expect((await bare.db.conversation.findFirstOrThrow()).handler).toBe('HUMAN');
    expect(await bare.db.alert.count({ where: { type: 'BOT_NOT_CONFIGURED' } })).toBe(1);
  });
});
