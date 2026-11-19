import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/contacts/csv.js';
import { inboundImagePayload, inboundTextPayload } from '../src/dev/payloads.js';
import { createTestContext, loginAsAdmin, PNID, resetDb, seedNumber, WABA, type TestContext } from './helpers.js';

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

async function clientWrites(text: string, from = '5511988887777', name = 'Maria Souza') {
  await ctx.postWebhook(inboundTextPayload({ wabaId: WABA, phoneNumberId: PNID, from, text, name }));
  await ctx.bus.drain();
  return ctx.db.conversation.findFirstOrThrow({ where: { contact: { phone: `+${from}` } } });
}

async function approvedTemplates() {
  await admin.call('POST', '/api/templates/sync');
  const list = (await admin.call('GET', '/api/templates?status=APPROVED')).json().templates as { id: string; name: string }[];
  return Object.fromEntries(list.map((t) => [t.name, t.id]));
}

describe('CSV', () => {
  it('lê ; e , com aspas, BOM e quebra de linha dentro de aspas', () => {
    expect(parseCsv('\uFEFFnome;telefone\r\n"Silva; Ana";11988887777\r\n')).toEqual([
      ['nome', 'telefone'],
      ['Silva; Ana', '11988887777'],
    ]);
    expect(parseCsv('nome,obs\n"Bia","linha 1\nlinha 2 com ""aspas"""\n')).toEqual([
      ['nome', 'obs'],
      ['Bia', 'linha 1\nlinha 2 com "aspas"'],
    ]);
  });
});

describe('importação de contatos', () => {
  const csv = [
    'Nome;Telefone;Tags;Opt-in',
    'Ana Lima;(11) 98888-1111;VIP|comprou árabe;sim',
    'Bruno;11977772222;;não',
    'Duplicado;5511988881111;;sim',
    'Sem número;;;sim',
    'Errado;1234;;sim',
    'Carla;21 96666-3333;suplemento;talvez',
  ].join('\n');

  it('simulação mostra válidos, rejeitados com motivo e não grava nada', async () => {
    const res = await admin.call('POST', '/api/contacts/import', { csv, optInSource: 'cadastro loja física', dryRun: true });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ totalLines: 6, valid: 2, created: 2, updated: 0, optInMarked: 1, dryRun: true });
    expect(r.rejected.map((x: { line: number; reason: string }) => [x.line, x.reason])).toEqual([
      [4, 'duplicado (mesmo número da linha 2)'],
      [5, 'telefone vazio'],
      [6, 'telefone inválido'],
      [7, 'opt-in não reconhecido (use sim/não)'],
    ]);
    expect(r.columns).toMatchObject({ telefone: 'Telefone', nome: 'Nome', tags: 'Tags', optIn: 'Opt-in' });
    expect(await ctx.db.contact.count()).toBe(0);
  });

  it('importa, cria tags, registra consentimento com origem e é idempotente', async () => {
    await admin.call('POST', '/api/contacts/import', { csv, optInSource: 'cadastro loja física', dryRun: false, defaultTags: ['importados nov'] });
    const ana = await ctx.db.contact.findUniqueOrThrow({
      where: { phone: '+5511988881111' },
      include: { tags: { include: { tag: true } }, consentLogs: true },
    });
    expect(ana.optIn).toBe(true);
    expect(ana.optInSource).toBe('csv:cadastro loja física');
    expect(ana.tags.map((t) => t.tag.name).sort()).toEqual(['VIP', 'comprou árabe', 'importados nov']);
    expect(ana.consentLogs).toHaveLength(1);
    const bruno = await ctx.db.contact.findUniqueOrThrow({ where: { phone: '+5511977772222' } });
    expect(bruno.optIn).toBe(false);

    const again = await admin.call('POST', '/api/contacts/import', { csv, optInSource: 'cadastro loja física', dryRun: false });
    expect(again.json()).toMatchObject({ created: 0, updated: 2, optInMarked: 0 });
    expect(await ctx.db.consentLog.count()).toBe(1);
  });

  it('nunca reativa quem pediu para sair', async () => {
    await ctx.db.contact.create({ data: { phone: '+5511988881111', optOut: true, optOutAt: new Date() } });
    const r = (await admin.call('POST', '/api/contacts/import', { csv, optInSource: 'site', dryRun: false })).json();
    expect(r.skippedOptOut).toBe(1);
    const ana = await ctx.db.contact.findUniqueOrThrow({ where: { phone: '+5511988881111' } });
    expect(ana).toMatchObject({ optIn: false, optOut: true });
  });

  it('exige origem do consentimento quando há opt-in', async () => {
    const res = await admin.call('POST', '/api/contacts/import', { csv, dryRun: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/origem do consentimento/);
  });

  it('recusa arquivo sem coluna de telefone', async () => {
    const res = await admin.call('POST', '/api/contacts/import', { csv: 'nome;email\nAna;a@b.com', dryRun: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/coluna de telefone/);
  });
});

describe('contatos, segmentos e LGPD', () => {
  it('filtra por tag e consentimento e conta o alcance de um segmento', async () => {
    const vip = (await admin.call('POST', '/api/tags', { name: 'VIP' })).json().tag;
    await admin.call('POST', '/api/contacts', { phone: '11911110000', name: 'A', tagIds: [vip.id], optInSource: 'balcão' });
    await admin.call('POST', '/api/contacts', { phone: '11922220000', name: 'B', tagIds: [vip.id] });
    await admin.call('POST', '/api/contacts', { phone: '11933330000', name: 'C' });

    const byTag = (await admin.call('GET', `/api/contacts?tags=${vip.id}`)).json();
    expect(byTag.total).toBe(2);
    const opted = (await admin.call('GET', '/api/contacts?consent=optIn')).json();
    expect(opted.contacts.map((c: { name: string }) => c.name)).toEqual(['A']);
    const count = (await admin.call('POST', '/api/segments/count', { tagsAny: [vip.id] })).json();
    expect(count).toEqual({ total: 2, reachable: 1 });
    const dup = await admin.call('POST', '/api/contacts', { phone: '(11) 91111-0000' });
    expect(dup.statusCode).toBe(409);
  });

  it('opt-out manual pelo painel fica registrado', async () => {
    const c = (await admin.call('POST', '/api/contacts', { phone: '11911110000', optInSource: 'site' })).json().contact;
    const res = await admin.call('POST', `/api/contacts/${c.id}/consent`, { action: 'OPT_OUT', source: 'pediu por telefone' });
    const detail = res.json().contact;
    expect(detail.optOut).toBe(true);
    expect(detail.consentLogs.map((l: { action: string }) => l.action)).toEqual(['OPT_OUT', 'OPT_IN']);
  });

  it('exporta todos os dados do contato e exclui com confirmação', async () => {
    const conv = await clientWrites('Oi, quero meus dados');
    const exp = await admin.call('GET', `/api/contacts/${conv.contactId}/export`);
    expect(exp.headers['content-disposition']).toContain('dados-contato-5511988887777.json');
    const data = exp.json();
    expect(data.contato.telefone).toBe('+5511988887777');
    expect(data.conversas[0].mensagens.length).toBeGreaterThanOrEqual(2);

    const wrong = await admin.call('POST', `/api/contacts/${conv.contactId}/delete`, { confirmPhone: '11900000000' });
    expect(wrong.statusCode).toBe(400);
    const ok = await admin.call('POST', `/api/contacts/${conv.contactId}/delete`, { confirmPhone: '(11) 98888-7777' });
    expect(ok.statusCode).toBe(200);
    expect(await ctx.db.contact.count()).toBe(0);
    expect(await ctx.db.message.count()).toBe(0);
  });
});

describe('inbox', () => {
  it('lista conversas com filtros, contagens e última mensagem', async () => {
    await seedNumber(ctx.db);
    const a = await clientWrites('Oi', '5511900000001', 'Ana');
    await clientWrites('Olá', '5511900000002', 'Bia');
    await admin.call('POST', `/api/conversations/${a.id}/assume`);

    const all = (await admin.call('GET', '/api/conversations')).json();
    expect(all.conversations).toHaveLength(2);
    expect(all.counts).toMatchObject({ bot: 1, human: 1 });
    expect(all.conversations[0].lastMessage).not.toBeNull();
    const human = (await admin.call('GET', '/api/conversations?filter=human')).json();
    expect(human.conversations.map((c: { contact: { name: string } }) => c.contact.name)).toEqual(['Ana']);
    const search = (await admin.call('GET', '/api/conversations?search=bia')).json();
    expect(search.conversations).toHaveLength(1);
  });

  it('assumir pausa o bot; devolver reativa', async () => {
    await seedNumber(ctx.db);
    const conv = await clientWrites('Oi');
    expect(ctx.meta.sent).toHaveLength(1); // resposta do bot
    await admin.call('POST', `/api/conversations/${conv.id}/assume`);
    await clientWrites('Tem alguém aí?');
    expect(ctx.meta.sent).toHaveLength(1); // bot ficou quieto
    await admin.call('POST', `/api/conversations/${conv.id}/release`);
    await clientWrites('E agora?');
    expect(ctx.meta.sent).toHaveLength(2);
  });

  it('atendente responde: assume automaticamente, envia e zera não lidas', async () => {
    await seedNumber(ctx.db);
    const conv = await clientWrites('Oi');
    const res = await admin.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Oi Maria! Sou a Carla, da Oliver.' });
    expect(res.statusCode).toBe(201);
    const after = await ctx.db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(after).toMatchObject({ handler: 'HUMAN', unreadCount: 0, awaitingReply: false });
    expect(ctx.meta.sent.at(-1)?.body).toMatchObject({ type: 'text', text: { body: 'Oi Maria! Sou a Carla, da Oliver.' } });
    const msgs = (await admin.call('GET', `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(msgs.map((m: { sentBy: string }) => m.sentBy)).toEqual(['CONTACT', 'BOT', 'HUMAN']);
  });

  it('fora da janela de 24h recusa texto (409) e aceita template aprovado', async () => {
    await seedNumber(ctx.db);
    const conv = await clientWrites('Oi');
    await ctx.db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 30 * 3600_000) } });
    const txt = await admin.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Oi!' });
    expect(txt.statusCode).toBe(409);
    expect(txt.json().error).toMatch(/janela de 24h/);

    const ids = await approvedTemplates();
    const tpl = await admin.call('POST', `/api/conversations/${conv.id}/template`, { templateId: ids.hello_world });
    expect(tpl.statusCode).toBe(201);
    expect(ctx.meta.sent.at(-1)?.body).toMatchObject({ type: 'template', template: { name: 'hello_world' } });
  });

  it('template de marketing: exige opt-in, bloqueia opt-out e preenche variáveis', async () => {
    await seedNumber(ctx.db);
    const conv = await clientWrites('Oi');
    const ids = await approvedTemplates();
    const noConsent = await admin.call('POST', `/api/conversations/${conv.id}/template`, { templateId: ids.promo_arabes, body: ['Maria', 'Lattafa'] });
    expect(noConsent.statusCode).toBe(409);
    expect(noConsent.json().error).toMatch(/opt-in/);

    await ctx.db.contact.update({ where: { id: conv.contactId }, data: { optIn: true } });
    const missing = await admin.call('POST', `/api/conversations/${conv.id}/template`, { templateId: ids.promo_arabes, body: ['Maria'] });
    expect(missing.statusCode).toBe(400);
    const ok = await admin.call('POST', `/api/conversations/${conv.id}/template`, { templateId: ids.promo_arabes, body: ['Maria', 'Lattafa\nnova'] });
    expect(ok.statusCode).toBe(201);
    expect(ctx.meta.sent.at(-1)?.body).toMatchObject({
      template: { components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }, { type: 'text', text: 'Lattafa nova' }] }] },
    });
    const stored = await ctx.db.message.findFirstOrThrow({ where: { type: 'template' } });
    expect(stored.body).toContain('Oi Maria! Chegaram novidades de Lattafa nova');

    await ctx.db.contact.update({ where: { id: conv.contactId }, data: { optOut: true } });
    const blocked = await admin.call('POST', `/api/conversations/${conv.id}/template`, { templateId: ids.promo_arabes, body: ['Maria', 'X'] });
    expect(blocked.statusCode).toBe(409);
  });

  it('inicia conversa com um contato por template', async () => {
    const n = await seedNumber(ctx.db);
    const c = (await admin.call('POST', '/api/contacts', { phone: '11955554444', name: 'Duda' })).json().contact;
    const ids = await approvedTemplates();
    const res = await admin.call('POST', `/api/contacts/${c.id}/start-conversation`, { numberId: n.id, templateId: ids.hello_world });
    expect(res.statusCode).toBe(201);
    expect(ctx.meta.sent[0]?.body).toMatchObject({ to: '5511955554444', type: 'template' });
  });

  it('envia imagem do painel (upload para a Meta) e exibe mídia recebida', async () => {
    await seedNumber(ctx.db);
    const conv = await clientWrites('Oi');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const boundary = '----oliver';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nOlha esse!\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="perfume.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/media`,
      headers: { cookie: `oh_session=${admin.cookie.value}`, 'x-oliver-panel': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.meta.sent.at(-1)?.body).toMatchObject({ type: 'image', image: { caption: 'Olha esse!' } });
    const sent = res.json().message;
    const media = await admin.call('GET', `/api/media/${sent.id}`);
    expect(media.headers['content-type']).toBe('image/png');
    expect(media.rawPayload.equals(png)).toBe(true); // o arquivo que voltou é exatamente o enviado

    // mídia recebida do cliente
    ctx.meta.media.set('IN_MEDIA1', { data: png, mime: 'image/jpeg' });
    await ctx.postWebhook(inboundImagePayload({ wabaId: WABA, phoneNumberId: PNID, from: '5511988887777', mediaId: 'IN_MEDIA1', caption: 'esse aqui' }));
    await ctx.bus.drain();
    const inbound = await ctx.db.message.findFirstOrThrow({ where: { type: 'image', direction: 'INBOUND' } });
    expect(inbound.body).toBe('esse aqui');
    const got = await admin.call('GET', `/api/media/${inbound.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(png)).toBe(true);
  });

  it('respostas rápidas: cria com atalho normalizado e recusa duplicado', async () => {
    const res = await admin.call('POST', '/api/quick-replies', { shortcut: 'PIX', title: 'Pix', body: 'Nossa chave Pix é…' });
    expect(res.json().quickReply.shortcut).toBe('/pix');
    expect((await admin.call('POST', '/api/quick-replies', { shortcut: '/pix', title: 'x', body: 'y' })).statusCode).toBe(409);
    expect((await admin.call('GET', '/api/quick-replies')).json().quickReplies).toHaveLength(1);
  });
});
