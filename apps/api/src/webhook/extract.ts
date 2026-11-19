import { sha256 } from '../lib/crypto.js';
import type { MetaChangeValue, MetaInboundMessage, MetaStatus, MetaWebhookPayload } from '../whatsapp/webhook-types.js';

export type ExtractedEvent =
  | {
      kind: 'message';
      key: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhone?: string;
      contactName?: string;
      message: MetaInboundMessage;
    }
  | { kind: 'status'; key: string; wabaId: string; phoneNumberId: string; status: MetaStatus }
  | { kind: 'quality'; key: string; wabaId: string; value: MetaChangeValue }
  | { kind: 'template_status'; key: string; wabaId: string; value: MetaChangeValue };

/** Quebra o payload da Meta em eventos individuais, cada um com chave de idempotência. */
export function extractEvents(payload: MetaWebhookPayload): ExtractedEvent[] {
  const out: ExtractedEvent[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'messages') {
        const phoneNumberId = v.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        for (const m of v.messages ?? []) {
          const contact = v.contacts?.find((c) => c.wa_id === m.from) ?? v.contacts?.[0];
          out.push({
            kind: 'message',
            key: `msg:${m.id}`,
            wabaId: entry.id,
            phoneNumberId,
            displayPhone: v.metadata?.display_phone_number,
            contactName: contact?.profile?.name,
            message: m,
          });
        }
        for (const s of v.statuses ?? []) {
          out.push({ kind: 'status', key: `status:${s.id}:${s.status}`, wabaId: entry.id, phoneNumberId, status: s });
        }
      } else if (change.field === 'phone_number_quality_update') {
        out.push({ kind: 'quality', key: `quality:${sha256(JSON.stringify(v))}`, wabaId: entry.id, value: v });
      } else if (change.field === 'message_template_status_update') {
        out.push({ kind: 'template_status', key: `tpl:${sha256(JSON.stringify(v))}`, wabaId: entry.id, value: v });
      }
    }
  }
  return out;
}

/** Texto legível de qualquer tipo de mensagem recebida (para histórico, opt-out e bot). */
export function inboundText(m: MetaInboundMessage): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'button':
      return m.button?.text ?? null;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case 'image':
      return m.image?.caption ?? null;
    case 'video':
      return m.video?.caption ?? null;
    case 'document':
      return m.document?.caption ?? m.document?.filename ?? null;
    case 'location':
      return m.location ? `📍 ${m.location.name ?? ''} ${m.location.address ?? ''}`.trim() : null;
    case 'reaction':
      return m.reaction?.emoji ?? null;
    default:
      return null;
  }
}

export function inboundMedia(m: MetaInboundMessage): { id: string; mime?: string } | null {
  const media = m.image ?? m.audio ?? m.video ?? m.document ?? m.sticker;
  return media?.id ? { id: media.id, mime: media.mime_type } : null;
}
