/**
 * Contrato de envio de WhatsApp. Hoje só existe MetaCloudProvider (API oficial).
 * Outro provedor oficial (BSP) = nova classe implementando esta interface.
 */

export interface SendResult {
  /** wamid.* retornado pelo provedor */
  messageId: string;
  /** wa_id do destinatário, quando o provedor devolve */
  waId?: string;
}

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
  image?: { link?: string; id?: string };
  document?: { link?: string; id?: string; filename?: string };
  video?: { link: string };
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: string;
  parameters: TemplateParameter[];
}

export interface SendTemplateInput {
  to: string; // E.164
  name: string;
  language: string; // ex.: pt_BR
  components?: TemplateComponent[];
}

export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'sticker';

export interface SendMediaInput {
  to: string;
  kind: MediaKind;
  /** link público OU id de mídia já enviada à Meta */
  link?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

export interface ReplyButton {
  id: string;
  title: string; // máx. 20 caracteres
}

export interface SendButtonsInput {
  to: string;
  body: string;
  buttons: ReplyButton[]; // máx. 3
  header?: string;
  footer?: string;
}

export interface ListRow {
  id: string;
  title: string; // máx. 24
  description?: string; // máx. 72
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export interface SendListInput {
  to: string;
  body: string;
  buttonText: string; // máx. 20
  sections: ListSection[];
  header?: string;
  footer?: string;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string; // GREEN | YELLOW | RED | UNKNOWN
  messagingLimitTier?: string; // TIER_250 | TIER_1K | ...
  status?: string;
  nameStatus?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendText(to: string, body: string, opts?: { previewUrl?: boolean; replyTo?: string }): Promise<SendResult>;
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  sendMedia(input: SendMediaInput): Promise<SendResult>;
  sendButtons(input: SendButtonsInput): Promise<SendResult>;
  sendList(input: SendListInput): Promise<SendResult>;
  markAsRead(messageId: string): Promise<void>;
  getPhoneNumberInfo(): Promise<PhoneNumberInfo>;
  /** Sobe um arquivo para o provedor e devolve o id de mídia para usar em sendMedia. */
  uploadMedia(data: Buffer, mimeType: string, filename: string): Promise<string>;
  /** Baixa uma mídia (recebida ou enviada) pelo id. */
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number | string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }

  /** 429/5xx e alguns códigos de throttling da Meta valem retry. */
  get retryable(): boolean {
    if (this.status === 429 || this.status >= 500) return true;
    // 4, 80007, 130429, 131048, 131056 = limites de taxa/throughput
    return [4, 80007, 130429, 131048, 131056].includes(Number(this.code));
  }
}
