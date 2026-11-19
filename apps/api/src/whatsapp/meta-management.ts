import { WhatsAppApiError } from './provider.js';

/** Endpoints de gestão da WABA (templates, números) — não envolvem envio de mensagens. */

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string; // APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL
  category: string;
  components: TemplateComponentDef[];
  rejected_reason?: string;
}

export interface TemplateComponentDef {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][]; header_handle?: string[] };
  buttons?: { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone_number?: string; example?: string[] }[];
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY';
  components: TemplateComponentDef[];
}

export interface WabaPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
  status?: string;
}

export interface MetaManagementConfig {
  accessToken: string;
  baseUrl: string;
  apiVersion: string;
}

export class MetaManagementClient {
  constructor(private readonly cfg: MetaManagementConfig) {
    if (!cfg.accessToken) throw new Error('META_ACCESS_TOKEN não configurado');
  }

  /**
   * Envia um arquivo de EXEMPLO para criar template com mídia no cabeçalho (API de upload
   * retomável da Meta: abre a sessão no app e manda os bytes). Devolve o "handle" do exemplo.
   */
  async uploadTemplateSample(appId: string, data: Buffer, mime: string, filename: string): Promise<string> {
    const base = `${this.cfg.baseUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}`;
    const q = new URLSearchParams({ file_name: filename, file_length: String(data.length), file_type: mime });
    // sem corpo e sem Content-Type (JSON vazio é recusado)
    let res: Response;
    try {
      res = await fetch(`${base}/${appId}/uploads?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao chamar a Meta: ${(err as Error).message}`, 503);
    }
    const opened = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
    if (!res.ok || !opened.id) throw new WhatsAppApiError(opened.error?.message ?? `Sessão de upload recusada (HTTP ${res.status})`, res.status, opened.error?.code, opened);
    const session = { id: opened.id };
    try {
      res = await fetch(`${base}/${session.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${this.cfg.accessToken}`, file_offset: '0' },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao enviar o exemplo para a Meta: ${(err as Error).message}`, 503);
    }
    const json = (await res.json().catch(() => ({}))) as { h?: string; error?: { message?: string; code?: number } };
    if (!res.ok || !json.h) throw new WhatsAppApiError(json.error?.message ?? `Upload do exemplo recusado (HTTP ${res.status})`, res.status, json.error?.code, json);
    return json.h;
  }

  private async call<T>(method: 'GET' | 'POST', pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.cfg.baseUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${pathOrUrl}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new WhatsAppApiError(`Falha de rede ao chamar a Meta: ${(err as Error).message}`, 503);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; error_user_msg?: string; code?: number } };
    if (!res.ok) {
      const msg = json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${res.status}`;
      throw new WhatsAppApiError(msg, res.status, json.error?.code, json);
    }
    return json as T;
  }

  async listTemplates(wabaId: string): Promise<MetaTemplate[]> {
    const out: MetaTemplate[] = [];
    let next: string | undefined = `${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,rejected_reason`;
    for (let page = 0; next && page < 50; page++) {
      const r: { data: MetaTemplate[]; paging?: { next?: string } } = await this.call('GET', next);
      out.push(...r.data);
      next = r.paging?.next;
    }
    return out;
  }

  createTemplate(wabaId: string, input: CreateTemplateInput): Promise<{ id: string; status: string; category: string }> {
    return this.call('POST', `${wabaId}/message_templates`, input);
  }

  async listPhoneNumbers(wabaId: string): Promise<WabaPhoneNumber[]> {
    const r = await this.call<{ data: WabaPhoneNumber[] }>(
      'GET',
      `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`,
    );
    return r.data;
  }
}
