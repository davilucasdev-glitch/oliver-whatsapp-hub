import Fastify, { type FastifyInstance } from 'fastify';
import { statusPayload } from './payloads.js';
import { signMetaPayload } from '../whatsapp/signature.js';

/**
 * Dev: devolve recibos de entrega ao /webhook da API, como a Meta faria
 * (enviado → entregue → lido para ~60% dos destinatários). Telefones terminados em 0000 "não têm WhatsApp" (erro 131026).
 */
export interface StatusWebhookOptions {
  url: string;
  secret: string;
  wabaId: string;
  delayMs?: number;
}

/**
 * Simulador mínimo da Graph API (WhatsApp Cloud) para testes e dev local.
 * Registra tudo que foi "enviado" e responde como a Meta responderia.
 */
export interface MockSentMessage {
  phoneNumberId: string;
  body: Record<string, unknown>;
  wamid: string;
  at: Date;
}

export interface MockMeta {
  url: string;
  app: FastifyInstance;
  sent: MockSentMessage[];
  readReceipts: string[];
  /** Dados devolvidos em GET /{phone_number_id} */
  numberInfo: Record<string, string>;
  /** Templates "existentes" na WABA */
  templates: { id: string; name: string; language: string; status: string; category: string; components: unknown[] }[];
  /** Números "existentes" na WABA */
  wabaNumbers: { id: string; display_phone_number: string; verified_name: string; quality_rating: string; messaging_limit_tier: string }[];
  /** Arquivos "hospedados" na Meta (upload do painel ou mídia recebida simulada) */
  media: Map<string, { data: Buffer; mime: string }>;
  /** quantos exemplos de mídia (upload retomável) foram enviados */
  sampleUploads: number;
  /** Aprova sozinho templates criados há mais de N ms (só no simulador de dev; nos testes fica desligado) */
  autoApproveMs?: number;
  /** Faz o próximo envio falhar com este erro da Meta */
  failNext?: { status: number; code: number; message: string };
  reset(): void;
  close(): Promise<void>;
}

export async function startMockMeta(port = 0, log = false, statusWebhook?: StatusWebhookOptions): Promise<MockMeta> {
  const app = Fastify({ logger: false });
  let seq = 0;
  const defaultTemplates = () => [
    {
      id: 'TPL_HELLO',
      name: 'hello_world',
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hello World' }],
    },
    {
      id: 'TPL_PROMO',
      name: 'promo_arabes',
      language: 'pt_BR',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Oi {{1}}! Chegaram novidades de {{2}} na Oliver 💜', example: { body_text: [['Maria', 'Lattafa']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero ver' }, { type: 'QUICK_REPLY', text: 'Parar promoções' }] },
      ],
    },
  ];
  const defaultWabaNumbers = () => [
    { id: '109876543210', display_phone_number: '55 11 4000-1234', verified_name: 'Oliver Cosmetics', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
  ];
  const state: MockMeta = {
    url: '',
    app,
    sent: [],
    readReceipts: [],
    numberInfo: { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', status: 'CONNECTED' },
    templates: defaultTemplates(),
    sampleUploads: 0,
    wabaNumbers: defaultWabaNumbers(),
    media: new Map(),
    reset() {
      state.media.clear();
      state.sent.length = 0;
      state.readReceipts.length = 0;
      state.failNext = undefined;
      state.numberInfo = { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', status: 'CONNECTED' };
      state.templates = defaultTemplates();
      state.wabaNumbers = defaultWabaNumbers();
    },
    close: () => app.close(),
  };

  app.post<{ Params: { ver: string; pnid: string }; Body: Record<string, unknown> }>(
    '/:ver/:pnid/messages',
    async (req, reply) => {
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: { message: 'Token ausente', code: 190 } });
      }
      const body = req.body;
      if (body.status === 'read') {
        state.readReceipts.push(String(body.message_id));
        return { success: true };
      }
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = undefined;
        return reply.code(f.status).send({ error: { message: f.message, code: f.code } });
      }
      const wamid = `wamid.MOCK${Date.now()}${++seq}`;
      state.sent.push({ phoneNumberId: req.params.pnid, body, wamid, at: new Date() });
      if (log) console.log(`[mock-meta] → ${String(body.to)} (${String(body.type)}):`, JSON.stringify(body[String(body.type)]));
      if (statusWebhook) emitStatuses(statusWebhook, req.params.pnid, wamid, String(body.to), log);
      return {
        messaging_product: 'whatsapp',
        contacts: [{ input: String(body.to), wa_id: String(body.to) }],
        messages: [{ id: wamid }],
      };
    },
  );

  const createdAt = new Map<string, number>();
  app.get('/:ver/:waba/message_templates', async () => {
    if (state.autoApproveMs !== undefined) {
      for (const t of state.templates) {
        const at = createdAt.get(t.id);
        if (t.status === 'PENDING' && at && Date.now() - at >= state.autoApproveMs) t.status = 'APPROVED';
      }
    }
    return { data: state.templates };
  });
  app.post<{ Body: { name: string; language: string; category: string; components: unknown[] } }>(
    '/:ver/:waba/message_templates',
    async (req, reply) => {
      if (state.templates.some((t) => t.name === req.body.name && t.language === req.body.language)) {
        return reply.code(400).send({ error: { message: 'Template já existe', error_user_msg: 'Já existe um modelo com esse nome', code: 100 } });
      }
      const t = { id: `TPL${++seq}`, status: 'PENDING', ...req.body };
      state.templates.push(t);
      createdAt.set(t.id, Date.now());
      if (log) console.log(`[mock-meta] template criado: ${t.name} (${t.category})`);
      return { id: t.id, status: 'PENDING', category: t.category };
    },
  );
  app.get('/:ver/:waba/phone_numbers', async () => ({ data: state.wabaNumbers }));

  // Upload retomável (exemplo de mídia para criar template com PDF/imagem no cabeçalho)
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Params: { ver: string; app: string }; Querystring: Record<string, string> }>('/:ver/:app/uploads', async (req, reply) => {
    if (!req.query.file_length || !req.query.file_type) return reply.code(400).send({ error: { message: 'file_length e file_type obrigatórios', code: 100 } });
    return { id: `upload:SESS${++seq}` };
  });
  app.post<{ Params: { ver: string; session: string } }>('/:ver/:session', async (req, reply) => {
    if (!req.params.session.startsWith('upload:')) return reply.code(404).send({ error: { message: 'não existe', code: 100 } });
    if (!String(req.headers.authorization).startsWith('OAuth ')) return reply.code(401).send({ error: { message: 'OAuth obrigatório', code: 190 } });
    state.sampleUploads++;
    return { h: `HANDLE-${req.params.session.slice(7)}` };
  });

  // Mídia: upload (multipart) → id; GET id → URL temporária; URL → bytes
  app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Body: Buffer }>('/:ver/:pnid/media', async (req) => {
    // extrai só a parte "file" do multipart (como a Meta faria)
    const raw = req.body;
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(req.headers['content-type']))?.slice(1).find(Boolean) ?? '';
    const text = raw.toString('latin1');
    const fileHeader = /Content-Disposition: form-data; name="file"[^\r\n]*\r\n(?:Content-Type: ([^\r\n]+)\r\n)?\r\n/.exec(text);
    let data = raw;
    let mime = 'application/octet-stream';
    if (fileHeader && boundary) {
      const start = fileHeader.index + fileHeader[0].length;
      const end = raw.indexOf(Buffer.from(`\r\n--${boundary}`, 'latin1'), start);
      data = raw.subarray(start, end > 0 ? end : undefined);
      mime = fileHeader[1] ?? mime;
    }
    const id = `MEDIA${++seq}`;
    state.media.set(id, { data: Buffer.from(data), mime });
    return { id };
  });
  app.get<{ Params: { id: string } }>('/media-file/:id', async (req, reply) => {
    const m = state.media.get(req.params.id);
    if (!m) return reply.code(404).send();
    return reply.type(m.mime).send(m.data);
  });

  app.get<{ Params: { ver: string; pnid: string } }>('/:ver/:pnid', async (req) => {
    if (req.params.pnid.startsWith('MEDIA') || req.params.pnid.startsWith('IN_MEDIA')) {
      const m = state.media.get(req.params.pnid);
      return { id: req.params.pnid, url: `${state.url}/media-file/${req.params.pnid}`, mime_type: m?.mime ?? 'image/jpeg' };
    }
    return phoneInfo(req.params.pnid);
  });
  const phoneInfo = (pnid: string) => ({
    id: pnid,
    display_phone_number: '15550001111',
    verified_name: 'Oliver Cosmetics',
    ...state.numberInfo,
  });

  const address = await app.listen({ port, host: '127.0.0.1' });
  state.url = address;
  return state;
}

function emitStatuses(o: StatusWebhookOptions, phoneNumberId: string, wamid: string, to: string, log: boolean) {
  const recipient = to.replace(/D/g, '');
  const post = async (status: 'sent' | 'delivered' | 'read' | 'failed', error?: { code: number; title: string }) => {
    const raw = JSON.stringify(statusPayload({ wabaId: o.wabaId, phoneNumberId, wamid, status, recipient, error }));
    try {
      await fetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, o.secret) }, body: raw });
    } catch (err) {
      if (log) console.log('[mock-meta] webhook de status falhou:', (err as Error).message);
    }
  };
  const d = o.delayMs ?? 800;
  const later = (ms: number, fn: () => Promise<void>) => setTimeout(() => void fn(), ms).unref();
  if (recipient.endsWith('0000')) {
    later(d, () => post('failed', { code: 131026, title: 'Message undeliverable' }));
    return;
  }
  later(d, async () => {
    await post('sent');
    await post('delivered');
  });
  // lido para parte dos destinatários (determinístico pelo número)
  if (Number(recipient.slice(-2)) % 5 < 3) later(d * 3, () => post('read'));
}
