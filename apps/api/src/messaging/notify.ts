import type { Contact, PhoneNumber } from '@prisma/client';
import type { Deps } from '../deps.js';
import { sendTemplateInConversation, type Agent } from '../inbox/service.js';

/**
 * Envio de template para um telefone (cria contato e conversa se precisar).
 * Usado pelos avisos da equipe, relacionamento e fornecedores.
 */

export async function pickSendingNumber(deps: Deps, preferredId?: string | null): Promise<PhoneNumber | null> {
  if (preferredId) {
    const n = await deps.db.phoneNumber.findUnique({ where: { id: preferredId } });
    if (n?.isActive) return n;
  }
  return deps.db.phoneNumber.findFirst({ where: { isActive: true, role: { in: ['ATTENDANCE', 'BOTH'] } }, orderBy: { createdAt: 'asc' } });
}

export async function ensureContact(deps: Deps, phone: string, data: { name?: string | null; blingContactId?: string | null; isSupplier?: boolean } = {}): Promise<Contact> {
  let contact = await deps.db.contact.findUnique({ where: { phone } });
  const blingFree = data.blingContactId ? !(await deps.db.contact.findUnique({ where: { blingContactId: data.blingContactId } })) : false;
  if (!contact) {
    return deps.db.contact.create({
      data: { phone, name: data.name ?? null, blingContactId: blingFree ? data.blingContactId : null, isSupplier: data.isSupplier ?? false },
    });
  }
  const patch: { name?: string; blingContactId?: string; isSupplier?: boolean } = {};
  if (!contact.name && data.name) patch.name = data.name;
  if (!contact.blingContactId && blingFree && data.blingContactId) patch.blingContactId = data.blingContactId;
  if (data.isSupplier && !contact.isSupplier) patch.isSupplier = true;
  if (Object.keys(patch).length) contact = await deps.db.contact.update({ where: { id: contact.id }, data: patch });
  return contact;
}

export interface SendTo {
  phone: string;
  name?: string | null;
  blingContactId?: string | null;
  isSupplier?: boolean;
  templateName: string;
  body: string[];
  headerDocument?: { id?: string; link?: string; filename: string };
  headerImage?: { link?: string; id?: string };
  numberId?: string | null;
  /** quem clicou (mensagem sai como da equipe) — sem isso sai como "Sistema" */
  who?: Agent;
  /** responsável pela conversa depois do envio (ex.: Ellen para fornecedor) */
  ownerUserId?: string | null;
}

export class NotifyError extends Error {}

export async function sendTemplateTo(deps: Deps, input: SendTo): Promise<{ conversationId: string; messageId: string | null; contactId: string }> {
  const number = await pickSendingNumber(deps, input.numberId);
  if (!number) throw new NotifyError('Nenhum número de atendimento ativo.');
  const tpl = await deps.db.template.findFirst({ where: { name: input.templateName, wabaId: number.wabaId, status: 'APPROVED' } });
  if (!tpl) throw new NotifyError(`O template "${input.templateName}" ainda não está aprovado pela Meta.`);
  const contact = await ensureContact(deps, input.phone, { name: input.name, blingContactId: input.blingContactId, isSupplier: input.isSupplier });
  const conv = await deps.db.conversation.upsert({
    where: { contactId_phoneNumberId: { contactId: contact.id, phoneNumberId: number.id } },
    create: { contactId: contact.id, phoneNumberId: number.id },
    update: {},
  });
  const msg = await sendTemplateInConversation(
    deps,
    conv.id,
    { templateId: tpl.id, body: input.body, headerDocument: input.headerDocument, headerImage: input.headerImage },
    input.who ? 'HUMAN' : 'SYSTEM',
    input.who,
  );
  if (input.ownerUserId) {
    const owner = await deps.db.user.findUnique({ where: { id: input.ownerUserId } });
    if (owner?.active) await deps.db.conversation.update({ where: { id: conv.id }, data: { assignedToId: owner.id } });
  }
  return { conversationId: conv.id, messageId: msg?.id ?? null, contactId: contact.id };
}
