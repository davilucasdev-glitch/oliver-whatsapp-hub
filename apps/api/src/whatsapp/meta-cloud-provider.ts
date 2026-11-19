import type { Logger } from 'pino';
import { e164ToWaRecipient } from '../lib/phone.js';
import { childLogger } from '../lib/logger.js';
import {
  WhatsAppApiError,
  type PhoneNumberInfo,
  type SendButtonsInput,
  type SendListInput,
  type SendMediaInput,
  type SendResult,
  type SendTemplateInput,
  type WhatsAppProvider,
} from './provider.js';

export interface MetaCloudConfig {
  phoneNumberId: string;
  accessToken: string;
  baseUrl: string; // https://graph.facebook.com
  apiVersion: string; // v23.0
  timeoutMs?: number;
}

interface MetaSendResponse {
  messaging_product: 'whatsapp';
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** WhatsApp Business Cloud API (oficial da Meta). */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta-cloud';
  private readonly log: Logger;

  constructor(private readonly cfg: MetaCloudConfig) {
    if (!cfg.accessToken) throw new Error(`Número ${cfg.phoneNumberId} sem access token configurado`);
    this.log = childLogger('meta-cloud').child({ phoneNumberId: cfg.phoneNumberId });
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${path}`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao chamar a Meta: ${(err as Error).message}`, 503);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const e = (json as MetaErrorBody | undefined)?.error;
      const msg = e?.error_data?.details ?? e?.message ?? `HTTP ${res.status}`;
      this.log.warn({ status: res.status, code: e?.code, msg }, 'Erro da Graph API');
      throw new WhatsAppApiError(msg, res.status, e?.code, json);
    }
    return json as T;
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await this.request<MetaSendResponse>('POST', `${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...payload,
    });
    const id = res.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError('Resposta da Meta sem message id', 502, undefined, res);
    return { messageId: id, waId: res.contacts?.[0]?.wa_id };
  }

  sendText(to: string, body: string, opts?: { previewUrl?: boolean; replyTo?: string }): Promise<SendResult> {
    return this.send({
      to: e164ToWaRecipient(to),
      type: 'text',
      text: { body, preview_url: opts?.previewUrl ?? false },
      ...(opts?.replyTo ? { context: { message_id: opts.replyTo } } : {}),
    });
  }

  sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    return this.send({
      to: e164ToWaRecipient(input.to),
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        ...(input.components?.length ? { components: input.components } : {}),
      },
    });
  }

  sendMedia(input: SendMediaInput): Promise<SendResult> {
    if (!input.link && !input.mediaId) throw new Error('sendMedia exige link ou mediaId');
    const media: Record<string, unknown> = input.mediaId ? { id: input.mediaId } : { link: input.link };
    if (input.caption && input.kind !== 'audio' && input.kind !== 'sticker') media.caption = input.caption;
    if (input.filename && input.kind === 'document') media.filename = input.filename;
    return this.send({ to: e164ToWaRecipient(input.to), type: input.kind, [input.kind]: media });
  }

  sendButtons(input: SendButtonsInput): Promise<SendResult> {
    if (input.buttons.length < 1 || input.buttons.length > 3) throw new Error('Botões: de 1 a 3');
    return this.send({
      to: e164ToWaRecipient(input.to),
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(input.header ? { header: { type: 'text', text: input.header } } : {}),
        body: { text: input.body },
        ...(input.footer ? { footer: { text: input.footer } } : {}),
        action: {
          buttons: input.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    });
  }

  sendList(input: SendListInput): Promise<SendResult> {
    return this.send({
      to: e164ToWaRecipient(input.to),
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(input.header ? { header: { type: 'text', text: input.header } } : {}),
        body: { text: input.body },
        ...(input.footer ? { footer: { text: input.footer } } : {}),
        action: {
          button: input.buttonText.slice(0, 20),
          sections: input.sections.map((s) => ({
            title: s.title.slice(0, 24),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.request('POST', `${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  async uploadMedia(data: Buffer, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    let res: Response;
    try {
      res = await fetch(this.url(`${this.cfg.phoneNumberId}/media`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao enviar mídia: ${(err as Error).message}`, 503);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string } & MetaErrorBody;
    if (!res.ok || !json.id) {
      throw new WhatsAppApiError(json.error?.message ?? `Falha no upload (HTTP ${res.status})`, res.status, json.error?.code, json);
    }
    return json.id;
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    // 1) a Graph API devolve uma URL temporária; 2) a URL também exige o token
    const info = await this.request<{ url: string; mime_type: string }>('GET', mediaId);
    let res: Response;
    try {
      res = await fetch(info.url, {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao baixar mídia: ${(err as Error).message}`, 503);
    }
    if (!res.ok) throw new WhatsAppApiError(`Mídia indisponível (HTTP ${res.status})`, res.status);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: info.mime_type || res.headers.get('content-type') || 'application/octet-stream' };
  }

  async getPhoneNumberInfo(): Promise<PhoneNumberInfo> {
    const fields = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status';
    const r = await this.request<Record<string, string>>('GET', `${this.cfg.phoneNumberId}?fields=${fields}`);
    return {
      id: r.id ?? this.cfg.phoneNumberId,
      displayPhoneNumber: r.display_phone_number,
      verifiedName: r.verified_name,
      qualityRating: r.quality_rating,
      messagingLimitTier: r.messaging_limit_tier,
      status: r.status,
      nameStatus: r.name_status,
    };
  }
}
