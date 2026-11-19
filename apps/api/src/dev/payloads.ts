import type { MetaWebhookPayload } from '../whatsapp/webhook-types.js';

/** Geradores de payloads de webhook no formato da Meta (testes e simulação local). */

let counter = 0;
export function fakeWamid(): string {
  return `wamid.TEST${Date.now()}${++counter}`;
}

export interface InboundTextOpts {
  wabaId: string;
  phoneNumberId: string;
  from: string; // wa_id, ex.: 5511999999999
  text: string;
  name?: string;
  id?: string;
  timestamp?: Date;
}

export function inboundTextPayload(o: InboundTextOpts): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: o.phoneNumberId },
              contacts: [{ profile: { name: o.name ?? 'Cliente Teste' }, wa_id: o.from }],
              messages: [
                {
                  from: o.from,
                  id: o.id ?? fakeWamid(),
                  timestamp: String(Math.floor((o.timestamp ?? new Date()).getTime() / 1000)),
                  type: 'text',
                  text: { body: o.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function inboundImagePayload(o: Omit<InboundTextOpts, 'text'> & { mediaId: string; caption?: string }): MetaWebhookPayload {
  const p = inboundTextPayload({ ...o, text: '' });
  const msg = p.entry![0]!.changes![0]!.value.messages![0]!;
  delete msg.text;
  msg.type = 'image';
  msg.image = { id: o.mediaId, mime_type: 'image/jpeg', caption: o.caption };
  return p;
}

export function statusPayload(o: {
  wabaId: string;
  phoneNumberId: string;
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  recipient: string;
  error?: { code: number; title: string };
}): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: o.phoneNumberId },
              statuses: [
                {
                  id: o.wamid,
                  status: o.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: o.recipient,
                  ...(o.error ? { errors: [o.error] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function qualityPayload(o: { wabaId: string; displayPhone: string; event: string; currentLimit: string }): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: 'phone_number_quality_update',
            value: { display_phone_number: o.displayPhone, event: o.event, current_limit: o.currentLimit },
          },
        ],
      },
    ],
  };
}
