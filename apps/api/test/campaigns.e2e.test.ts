import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCampaignTick } from '../src/campaigns/engine.js';
import { inboundTextPayload, qualityPayload, statusPayload } from '../src/dev/payloads.js';
import { zonedParts, zonedToUtc } from '../src/lib/time.js';
import { createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAsAdmin>>;
let numberId: string;
let promoId: string;

const TZ = 'America/Sao_Paulo';
/** Hoje às HH:MM em São Paulo (os testes controlam o relógio do motor). */
function today(hour: number, minute = 0, plusDays = 0): Date {
  const p = zonedParts(new Date(), TZ);
  return zonedToUtc(p.year, p.month, p.day + plusDays, hour, minute, TZ);
}
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

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
  numberId = (await seedNumber(ctx.db)).id; // ritmo padrão 20/min = 1 a cada 3 s
  await admin.call('POST', '/api/templates/sync');
  promoId = (await ctx.db.template.findFirstOrThrow({ where: { name: 'promo_arabes' } })).id;
});

/** 3 aptos (VIP) + 1 opt-out + 1 sem opt-in + 1 que recebeu campanha há 2 dias. */
async function seedAudience() {
  const vip = await ctx.db.tag.create({ data: { name: 'VIP' } });
  const mk = (phone: string, name: string | null, extra: Record<string, unknown> = {}) =>
    ctx.db.contact.create({ data: { phone, name, optIn: true, optInAt: new Date(), optInSource: 'teste', tags: { create: { tagId: vip.id } }, ...extra } });
  const ana = await mk('+5511988880001', 'ANA LIMA');
  const bia = await mk('+5511988880002', 'Bia Souza');
  const caio = await mk('+5511988880003', null);
  await mk('+5511988880004', 'Dani', { optOut: true, optOutAt: new Date() });
  await mk('+5511988880005', 'Edu', { optIn: false });
  await mk('+5511988880006', 'Fabi', { lastCampaignAt: new Date(Date.now() - 2 * 86_400_000) });
  // fora do segmento (sem a tag)
  await ctx.db.contact.create({ data: { phone: '+5511988880007', name: 'Gil', optIn: true } });
  return { vip, ana, bia, caio };
}

async function createCampaign(over: Record<string, unknown> = {}, tagId?: string) {
  const res = await admin.call('POST', '/api/campaigns', {
    name: 'Novidades árabes',
    phoneNumberId: numberId,
    templateId: promoId,
    segment: { tagsAny: tagId ? [tagId] : [], tagsAll: [], excludeTags: [] },
    variables: { header: [], body: [{ source: 'firstName', fallback: 'cliente' }, { source: 'text', value: 'Lattafa' }] },
    windowStartHour: 9,
    windowEndHour: 20,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().campaign as { id: string };
}

const recipients = (campaignId: string) => ctx.db.campaignRecipient.findMany({ where: { campaignId }, include: { contact: true }, orderBy: { createdAt: 'asc' } });

describe('criação e público', () => {
  it('estimativa mostra quem pode receber e por que os outros ficam de fora', async () => {
    const { vip } = await seedAudience();
    const est = (await admin.call('POST', '/api/campaigns/estimate', { segment: { tagsAny: [vip.id] }, phoneNumberId: numberId, windowStartHour: 9, windowEndHour: 20 })).json();
    expect(est.total).toBe(6);
    expect(est.eligible).toBe(3);
    expect(Object.fromEntries(est.excluded.map((e: { reason: string; count: number }) => [e.reason, e.count]))).toEqual({ 'opt-out': 1, 'sem opt-in': 1, frequência: 1 });
    expect(est.timing).toMatchObject({ ratePerMinute: 20, days: 1 });
    expect(est.sample).toHaveLength(3);
  });

  it('pré-visualização com dados reais de um contato', async () => {
    const { vip, ana } = await seedAudience();
    const res = await admin.call('POST', '/api/campaigns/preview', {
      templateId: promoId,
      variables: { header: [], body: [{ source: 'firstName', fallback: 'cliente' }, { source: 'text', value: 'Lattafa' }] },
      segment: { tagsAny: [vip.id] },
      contactId: ana.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().text).toContain('Oi Ana! Chegaram novidades de Lattafa na Oliver');
    expect(res.json().contact.id).toBe(ana.id);
  });

  it('recusa número só de atendimento, janela de madrugada e variável faltando', async () => {
    const base = { name: 'Teste X', templateId: promoId, phoneNumberId: numberId, variables: { header: [], body: [{ source: 'firstName' }, { source: 'text', value: 'a' }] } };
    await ctx.db.phoneNumber.update({ where: { id: numberId }, data: { role: 'ATTENDANCE' } });
    expect((await admin.call('POST', '/api/campaigns', base)).json().error).toMatch(/só de atendimento/);
    await ctx.db.phoneNumber.update({ where: { id: numberId }, data: { role: 'CAMPAIGNS' } });
    expect((await admin.call('POST', '/api/campaigns', { ...base, windowStartHour: 6 })).json().error).toMatch(/antes das 8h/);
    expect((await admin.call('POST', '/api/campaigns', { ...base, variables: { header: [], body: [{ source: 'firstName' }] } })).json().error).toMatch(/2 variável/);
    const hello = await ctx.db.template.findFirstOrThrow({ where: { name: 'hello_world' } });
    await ctx.db.template.update({ where: { id: hello.id }, data: { status: 'PAUSED' } });
    expect((await admin.call('POST', '/api/campaigns', { ...base, templateId: hello.id, variables: { header: [], body: [] } })).json().error).toMatch(/não está aprovado/);
  });
});

describe('envio', () => {
  it('congela o público, envia no ritmo do número e conclui', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    const start = await admin.call('POST', `/api/campaigns/${c.id}/start`);
    expect(start.statusCode, start.body).toBe(200);
    expect(start.json().campaign.status).toBe('RUNNING');

    const rs = await recipients(c.id);
    expect(rs).toHaveLength(6);
    expect(rs.filter((r) => r.status === 'PENDING')).toHaveLength(3);
    expect(rs.filter((r) => r.status === 'SKIPPED').map((r) => r.skipReason).sort()).toEqual(['frequência', 'opt-out', 'sem opt-in']);

    const t0 = today(14);
    expect((await runCampaignTick(ctx.deps, t0)).sent).toBe(1);
    expect((await runCampaignTick(ctx.deps, plus(t0, 1000))).sent).toBe(0); // 1 a cada 3 s
    expect((await runCampaignTick(ctx.deps, plus(t0, 3000))).sent).toBe(1);
    const last = await runCampaignTick(ctx.deps, plus(t0, 6000));
    expect(last.sent).toBe(1);
    expect(last.completed).toBe(1); // acabou a fila: conclui na mesma rodada
    expect((await runCampaignTick(ctx.deps, plus(t0, 9000))).sent).toBe(0);

    expect(ctx.meta.sent).toHaveLength(3);
    const first = ctx.meta.sent[0]!.body as { to: string; type: string; template: { name: string; components: { parameters: { text: string }[] }[] } };
    expect(first.type).toBe('template');
    expect(first.template.name).toBe('promo_arabes');
    expect(first.template.components[0]!.parameters.map((p) => p.text)).toEqual(['Ana', 'Lattafa']);
    // sem nome → "cliente"
    const third = ctx.meta.sent[2]!.body as typeof first;
    expect(third.template.components[0]!.parameters[0]!.text).toBe('cliente');

    const camp = await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.status).toBe('COMPLETED');
    const contacts = await ctx.db.contact.findMany({ where: { lastCampaignAt: { gte: t0 } } });
    expect(contacts).toHaveLength(3);
    expect(await ctx.db.alert.count({ where: { type: 'CAMPAIGN_COMPLETED' } })).toBe(1);
    // histórico na conversa, marcado como campanha
    const msg = await ctx.db.message.findFirstOrThrow({ where: { campaignId: c.id } });
    expect(msg).toMatchObject({ sentBy: 'CAMPAIGN', type: 'template', templateName: 'promo_arabes' });
    expect(msg.body).toContain('Oi Ana!');
  });

  it('fora da janela não envia e diz quando volta', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    const r = await runCampaignTick(ctx.deps, today(22));
    expect(r.sent).toBe(0);
    const camp = await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.status).toBe('RUNNING');
    expect(camp.waitingReason).toMatch(/Fora da janela de envio \(9h às 20h\)\. Continua .*09:00/);
    expect((await runCampaignTick(ctx.deps, today(9, 0, 1))).sent).toBe(1);
  });

  it('agendada só começa na hora marcada', async () => {
    const { vip } = await seedAudience();
    const when = today(10, 0, 1);
    const p = zonedParts(when, TZ);
    const two = (n: number) => String(n).padStart(2, '0');
    const c = await createCampaign({ scheduledAt: `${p.year}-${two(p.month)}-${two(p.day)}T10:00` }, vip.id);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/start`)).json().campaign.status).toBe('SCHEDULED');
    expect((await runCampaignTick(ctx.deps, plus(when, -60_000))).started).toBe(0);
    expect(await ctx.db.campaignRecipient.count({ where: { campaignId: c.id } })).toBe(0); // público só é montado ao iniciar
    const r = await runCampaignTick(ctx.deps, plus(when, 60_000));
    expect(r.started).toBe(1);
    expect(r.sent).toBe(1);
  });

  it('pausar, retomar e cancelar', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    const t0 = today(14);
    await runCampaignTick(ctx.deps, t0);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/pause`)).statusCode).toBe(200);
    expect((await runCampaignTick(ctx.deps, plus(t0, 3000))).sent).toBe(0);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/resume`)).statusCode).toBe(200);
    expect((await runCampaignTick(ctx.deps, plus(t0, 6000))).sent).toBe(1);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/cancel`)).statusCode).toBe(200);
    expect((await runCampaignTick(ctx.deps, plus(t0, 9000))).sent).toBe(0);
    const rs = await recipients(c.id);
    expect(rs.filter((r) => r.skipReason === 'campanha cancelada')).toHaveLength(1);
    expect((await admin.call('DELETE', `/api/campaigns/${c.id}`)).statusCode).toBe(409); // histórico fica
  });

  it('duas campanhas no mesmo número dividem o ritmo do número', async () => {
    const { vip } = await seedAudience();
    const a = await createCampaign({ name: 'Campanha A' }, vip.id);
    await admin.call('POST', `/api/campaigns/${a.id}/start`);
    // a segunda vai para quem não tem tag (Gil)
    const b = await createCampaign({ name: 'Campanha B', segment: { tagsAny: [], tagsAll: [], excludeTags: [vip.id] } });
    await admin.call('POST', `/api/campaigns/${b.id}/start`);
    const t0 = today(14);
    expect((await runCampaignTick(ctx.deps, t0)).sent).toBe(1);
    expect((await runCampaignTick(ctx.deps, plus(t0, 3000))).sent).toBe(1);
    const sentBy = await ctx.db.campaignRecipient.groupBy({ by: ['campaignId'], where: { sentAt: { not: null } }, _count: { _all: true } });
    expect(sentBy).toHaveLength(2); // revezaram
  });

  it('frequência: quem acabou de receber não entra na próxima campanha', async () => {
    const { vip } = await seedAudience();
    const a = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${a.id}/start`);
    const t0 = new Date();
    // ritmo alto para enviar tudo de uma vez nesta rodada
    await ctx.db.phoneNumber.update({ where: { id: numberId }, data: { sendRatePerMinute: 600 } });
    for (let i = 0; i < 4; i++) await runCampaignTick(ctx.deps, plus(t0, i * 200), { catchUpMs: 0 });
    // horário real pode estar fora da janela: força dentro
    for (let i = 0; i < 4; i++) await runCampaignTick(ctx.deps, plus(today(14), i * 200));
    const b = await createCampaign({ name: 'Segunda' }, vip.id);
    const res = await admin.call('POST', `/api/campaigns/${b.id}/start`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Nenhum contato/);
  });

  it('limite diário (90% do tier) segura o envio', async () => {
    const { vip } = await seedAudience();
    await ctx.db.phoneNumber.update({ where: { id: numberId }, data: { dailyConversationLimit: 2 } }); // 90% = 1
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    const t0 = today(14);
    expect((await runCampaignTick(ctx.deps, t0)).sent).toBe(1);
    expect((await runCampaignTick(ctx.deps, plus(t0, 3000))).sent).toBe(0);
    expect((await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } })).waitingReason).toMatch(/Limite diário do número atingido \(1 de 1/);
  });

  it('envio de teste para o meu número não entra no relatório', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    const res = await admin.call('POST', `/api/campaigns/${c.id}/test`, { phone: '(11) 97777-6666' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().text).toContain('Oi cliente!');
    expect(ctx.meta.sent).toHaveLength(1);
    expect(await ctx.db.campaignRecipient.count()).toBe(0);
  });
});

describe('relatório e webhook', () => {
  it('entregue, lido, respondeu, opt-out e CSV', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    const t0 = today(14);
    for (let i = 0; i < 4; i++) await runCampaignTick(ctx.deps, plus(t0, i * 3000));
    const rs = (await recipients(c.id)).filter((r) => r.waMessageId);
    expect(rs).toHaveLength(3);
    const [ana, bia, caio] = rs as [(typeof rs)[number], (typeof rs)[number], (typeof rs)[number]];

    const status = (r: typeof ana, s: 'sent' | 'delivered' | 'read' | 'failed', error?: { code: number; title: string }) =>
      ctx.postWebhook(statusPayload({ wabaId: WABA, phoneNumberId: PNID, wamid: r.waMessageId!, status: s, recipient: r.contact.phone.slice(1), error }));
    await status(ana, 'delivered');
    await status(ana, 'read');
    await status(ana, 'delivered'); // fora de ordem: não volta
    await status(bia, 'delivered');
    await status(caio, 'failed', { code: 131049, title: 'ecosystem' });
    await ctx.bus.drain();
    // Ana responde, Bia pede para sair pelo botão
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: ana.contact.phone.slice(1), text: 'Quero ver' }));
    await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from: bia.contact.phone.slice(1), text: 'Parar promoções' }));
    await ctx.bus.drain();

    const d = (await admin.call('GET', `/api/campaigns/${c.id}`)).json();
    expect(d.counts).toMatchObject({ total: 6, sent: 3, delivered: 2, read: 1, replied: 2, failed: 1, optOuts: 1, skipped: 3, pending: 0 });
    expect(d.failures[0].message).toMatch(/limite por pessoa/);
    expect(d.skipReasons).toHaveLength(3);
    expect((await ctx.db.contact.findUniqueOrThrow({ where: { id: bia.contactId } })).optOut).toBe(true);

    const replied = (await admin.call('GET', `/api/campaigns/${c.id}/recipients?filter=replied`)).json();
    expect(replied.total).toBe(2);
    const csv = await admin.call('GET', `/api/campaigns/${c.id}/recipients.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('nome;telefone;status');
    expect(csv.body).toContain('+5511988880001');
  });

  it('cliente que bloqueou marketing no WhatsApp (131050) vira opt-out', async () => {
    const { vip, ana } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    ctx.meta.failNext = { status: 400, code: 131050, message: 'User stopped marketing' };
    await runCampaignTick(ctx.deps, today(14));
    expect((await ctx.db.contact.findUniqueOrThrow({ where: { id: ana.id } })).optOut).toBe(true);
    expect(await ctx.db.consentLog.count({ where: { contactId: ana.id, source: 'meta:131050' } })).toBe(1);
  });
});

describe('proteção do número', () => {
  it('spam (131048): pausa todas as campanhas do número, alerta e devolve o contato para a fila', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    ctx.meta.failNext = { status: 400, code: 131048, message: 'Spam rate limit hit' };
    await runCampaignTick(ctx.deps, today(14));
    const camp = await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.status).toBe('PAUSED');
    expect(camp.pausedReason).toMatch(/spam/);
    expect((await ctx.db.phoneNumber.findUniqueOrThrow({ where: { id: numberId } })).campaignsPaused).toBe(true);
    expect(await ctx.db.alert.count({ where: { type: 'CAMPAIGN_PAUSED', level: 'CRITICAL' } })).toBe(1);
    expect(await ctx.db.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDING' } })).toBe(3);
    // retomar exige liberar o número antes
    expect((await admin.call('POST', `/api/campaigns/${c.id}/resume`)).statusCode).toBe(409);
    await admin.call('POST', `/api/numbers/${numberId}/resume-campaigns`);
    expect((await admin.call('POST', `/api/campaigns/${c.id}/resume`)).statusCode).toBe(200);
  });

  it('Meta pede para desacelerar (130429): espera 1 minuto sem perder o contato', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    ctx.meta.failNext = { status: 400, code: 130429, message: 'Rate limit hit' };
    const t0 = today(14);
    await runCampaignTick(ctx.deps, t0);
    expect(await ctx.db.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDING' } })).toBe(3);
    expect((await runCampaignTick(ctx.deps, plus(t0, 30_000))).sent).toBe(0);
    expect((await runCampaignTick(ctx.deps, plus(t0, 61_000))).sent).toBe(1);
  });

  it('número inexistente (131026) marca falha e segue; muitas falhas pausam a campanha', async () => {
    const tag = await ctx.db.tag.create({ data: { name: 'lista comprada' } });
    for (let i = 0; i < 25; i++) {
      await ctx.db.contact.create({ data: { phone: `+55119888${String(i).padStart(5, '0')}`, optIn: true, tags: { create: { tagId: tag.id } } } });
    }
    const c = await createCampaign({}, tag.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    const t0 = today(14);
    for (let i = 0; i < 25; i++) {
      // todo envio "falha" na Meta
      ctx.meta.failNext = { status: 400, code: 131026, message: 'Message undeliverable' };
      await runCampaignTick(ctx.deps, plus(t0, i * 3000));
    }
    const camp = await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.status).toBe('PAUSED');
    expect(camp.pausedReason).toMatch(/dos envios falharam/);
    expect(await ctx.db.campaignRecipient.count({ where: { campaignId: c.id, status: 'FAILED' } })).toBe(20);
  });

  it('qualidade BAIXA pausa as campanhas do número e trava a retomada', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    ctx.meta.numberInfo = { quality_rating: 'RED', messaging_limit_tier: 'TIER_1K', status: 'CONNECTED' };
    await ctx.postWebhook(qualityPayload({ wabaId: WABA, displayPhone: '15550001111', event: 'FLAGGED', currentLimit: 'TIER_1K' }));
    await ctx.bus.drain();
    expect((await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PAUSED');
    expect((await runCampaignTick(ctx.deps, today(14))).sent).toBe(0);
    const res = await admin.call('POST', `/api/campaigns/${c.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/BAIXA/);
  });

  it('template pausado pela Meta pausa a campanha', async () => {
    const { vip } = await seedAudience();
    const c = await createCampaign({}, vip.id);
    await admin.call('POST', `/api/campaigns/${c.id}/start`);
    await ctx.postWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field: 'message_template_status_update', value: { event: 'PAUSED', message_template_name: 'promo_arabes', message_template_language: 'pt_BR', reason: 'baixa qualidade' } }] }],
    });
    await ctx.bus.drain();
    const camp = await ctx.db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.status).toBe('PAUSED');
    expect(camp.pausedReason).toMatch(/PAUSED/);
  });
});
