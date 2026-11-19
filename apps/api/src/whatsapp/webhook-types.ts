/** Tipos (parciais) do payload de webhook da WhatsApp Cloud API. */

export interface MetaWebhookPayload {
  object: string; // "whatsapp_business_account"
  entry?: MetaEntry[];
}

export interface MetaEntry {
  id: string; // WABA id
  changes?: MetaChange[];
}

export interface MetaChange {
  field: string; // "messages" | "message_template_status_update" | "phone_number_quality_update" | ...
  value: MetaChangeValue;
}

export interface MetaChangeValue {
  messaging_product?: 'whatsapp';
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: MetaInboundMessage[];
  statuses?: MetaStatus[];
  errors?: MetaError[];
  // phone_number_quality_update
  display_phone_number?: string;
  event?: string; // FLAGGED | UNFLAGGED | DOWNGRADE | UPGRADE | ONBOARDING
  current_limit?: string; // TIER_1K ...
  // message_template_status_update
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string | null;
  [k: string]: unknown;
}

export interface MetaInboundMessage {
  from: string; // wa_id
  id: string; // wamid
  timestamp: string; // unix seconds
  type: string; // text | image | audio | video | document | sticker | location | contacts | button | interactive | reaction | unsupported
  text?: { body: string };
  image?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  document?: MetaMedia & { filename?: string };
  sticker?: MetaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  button?: { text: string; payload: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  reaction?: { message_id: string; emoji: string };
  context?: { from?: string; id?: string };
  errors?: MetaError[];
}

export interface MetaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

export interface MetaStatus {
  id: string; // wamid
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  timestamp: string;
  recipient_id: string;
  errors?: MetaError[];
  conversation?: { id: string; origin?: { type: string } };
  pricing?: { billable: boolean; category: string };
}

export interface MetaError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}
