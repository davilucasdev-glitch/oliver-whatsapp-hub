import { randomBytes } from 'node:crypto';
import type { Deps } from '../deps.js';
import { createCampaign, estimateAudience } from '../campaigns/service.js';
import { badRequest, HttpError } from '../http/errors.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { NotifyError, pickSendingNumber, sendTemplateTo } from '../messaging/notify.js';
import { templateVariables } from '../templates/service.js';
import type { TemplateComponentDef } from '../whatsapp/meta-management.js';
import { getSiteConfig } from './config.js';

/**
 * O que o site/painel pede ao hub (rotas /api/site/v1/*).
 * Regras do documento: marketing só com opt-in e nunca para quem saiu; campanha nunca sai
 * sem a administradora aprovar a arte e o público (o painel só cria o RASCUNHO).
 */

const log = childLogger('site');

export function phoneOrThrow(raw: string, field = 'phone'): string {
  const p = normalizePhone(raw);
  if (!p) throw badRequest(`${field}: telefone inválido (use 55 + DDD + número)`);
  return p;
}

/** Templates aprovados com quantas variáveis e se pedem anexo (o site só usa template aprovado). */
export async function siteTemplates(deps: Deps) {
  const rows = await deps.db.template.findMany({ where: { status: { not: 'DELETED' } }, orderBy: { name: 'asc' } });
  return rows.map((t) => {
    const defs = t.components as unknown as TemplateComponentDef[];
    const body = defs.find((c) => c.type === 'BODY');
    const header = defs.find((c) => c.type === 'HEADER');
    return {
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      variables: templateVariables(body?.text).length,
      text: body?.text ?? '',
      attachment: header?.format === 'DOCUMENT' ? 'pdf' : header?.format === 'IMAGE' ? 'image' : null,
    };
  });
}

export interface SiteSendInput {
  phone: string;
  template: string;
  variables: string[];
  name?: string | null;
  ref?: string | null;
  attachment?: { url?: string; base64?: string; mime?: string; filename?: string } | null;
}

export async function siteSend(deps: Deps, input: SiteSendInput) {
  const phone = phoneOrThrow(input.phone);
  if (input.ref) {
    const prev = await deps.db.siteMessage.findUnique({ where: { ref: input.ref } });
    if (prev) return { id: prev.id, ref: prev.ref, messageId: prev.messageId, status: prev.status, duplicate: true, error: prev.error };
  }
  const number = await pickSendingNumber(deps);
  if (!number) throw new HttpError(503, 'Nenhum número de atendimento ativo no hub.');
  const tpl = await deps.db.template.findFirst({ where: { name: input.template, wabaId: number.wabaId, status: { not: 'DELETED' } } });
  if (!tpl) throw badRequest(`Template "${input.template}" não existe no hub.`);
  if (tpl.status !== 'APPROVED') throw badRequest(`Template "${input.template}" não está aprovado pela Meta (${tpl.status}).`);
  const header = (tpl.components as unknown as TemplateComponentDef[]).find((c) => c.type === 'HEADER');
  const needs = header?.format === 'DOCUMENT' ? 'document' : header?.format === 'IMAGE' ? 'image' : null;

  let headerDocument: { id?: string; link?: string; filename: string } | undefined;
  let headerImage: { id?: string; link?: string } | undefined;
  if (needs) {
    const a = input.attachment;
    if (!a || (!a.url && !a.base64)) throw badRequest(`O template "${tpl.name}" precisa de anexo (${needs === 'document' ? 'PDF' : 'imagem'}): attachment.url ou attachment.base64.`);
    if (a.url && !/^https:\/\//.test(a.url)) throw badRequest('attachment.url precisa ser https.');
    let id: string | undefined;
    if (a.base64) {
      const data = Buffer.from(a.base64, 'base64');
      if (!data.length || data.length > 16 * 1024 * 1024) throw badRequest('attachment.base64 vazio ou acima de 16 MB.');
      const mime = a.mime ?? (needs === 'document' ? 'application/pdf' : 'image/jpeg');
      id = await deps.providers(number).uploadMedia(data, mime, a.filename ?? (needs === 'document' ? 'documento.pdf' : 'imagem.jpg'));
    }
    if (needs === 'document') headerDocument = { ...(id ? { id } : { link: a.url! }), filename: a.filename ?? 'Oliver Cosmeticos.pdf' };
    else headerImage = id ? { id } : { link: a.url! };
  }

  try {
    const r = await sendTemplateTo(deps, { phone, name: input.name ?? null, templateName: tpl.name, body: input.variables, headerDocument, headerImage, numberId: number.id });
    const row = await deps.db.siteMessage.create({ data: { ref: input.ref ?? null, phone, templateName: tpl.name, messageId: r.messageId, status: 'SENT' } });
    return { id: row.id, ref: row.ref, messageId: r.messageId, status: 'SENT', duplicate: false, error: null };
  } catch (err) {
    const reason = (err instanceof NotifyError || err instanceof HttpError ? err.message : (err as Error).message).slice(0, 300);
    const row = await deps.db.siteMessage.create({ data: { ref: input.ref ?? null, phone, templateName: tpl.name, status: 'FAILED', error: reason } });
    log.warn({ template: tpl.name, err: reason }, 'Envio pedido pelo site falhou');
    return { id: row.id, ref: row.ref, messageId: null, status: 'FAILED', duplicate: false, error: reason };
  }
}

/** Opt-in vindo do site (LGPD: guarda quando e como). */
export async function siteOptIn(deps: Deps, input: { phone: string; name?: string | null; source: string; at?: string | null }) {
  const phone = phoneOrThrow(input.phone);
  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) throw badRequest('at: data inválida (use ISO 8601)');
  const existing = await deps.db.contact.findUnique({ where: { phone } });
  if (existing?.optOut) {
    // quem pediu para sair só volta pelo próprio WhatsApp (mandando VOLTAR) ou pela equipe
    return { phone, optIn: false, reason: 'Este número pediu para sair (SAIR) e não volta pelo site.' };
  }
  const source = `site:${input.source}`.slice(0, 120);
  const contact = existing
    ? await deps.db.contact.update({ where: { id: existing.id }, data: { optIn: true, optInAt: at, optInSource: source, name: existing.name ?? input.name ?? null } })
    : await deps.db.contact.create({ data: { phone, name: input.name ?? null, optIn: true, optInAt: at, optInSource: source } });
  await deps.db.consentLog.create({ data: { contactId: contact.id, action: 'OPT_IN', source, detail: `informado pelo site em ${at.toISOString()}` } });
  return { phone, optIn: true, reason: null };
}

export async function siteOptOuts(deps: Deps, since?: string | null) {
  const from = since ? new Date(since) : null;
  if (from && Number.isNaN(from.getTime())) throw badRequest('since: data inválida (use ISO 8601)');
  const rows = await deps.db.contact.findMany({
    where: { optOut: true, ...(from ? { optOutAt: { gte: from } } : {}) },
    select: { phone: true, optOutAt: true },
    orderBy: { optOutAt: 'asc' },
    take: 5000,
  });
  return rows.map((r) => ({ phone: r.phone, at: r.optOutAt }));
}

export async function siteCart(deps: Deps, input: { ref: string; phone: string; name?: string | null; items: { name: string; qty: number }[]; total?: number | null; link: string }) {
  const phone = phoneOrThrow(input.phone);
  const data = { phone, name: input.name ?? null, items: input.items, total: input.total ?? null, link: input.link, recoveredAt: null };
  const row = await deps.db.abandonedCart.upsert({ where: { ref: input.ref }, create: { ref: input.ref, ...data }, update: data });
  return { id: row.id, ref: row.ref };
}

export async function siteCartRecovered(deps: Deps, ref: string) {
  const r = await deps.db.abandonedCart.updateMany({ where: { ref, recoveredAt: null }, data: { recoveredAt: new Date() } });
  return { ref, updated: r.count };
}

const SEGMENT_LABEL = { varejo: 'Varejo', atacado: 'Atacado', todos: 'Todos' } as const;

export interface PainelCampaignInput {
  name: string;
  text: string;
  segment: keyof typeof SEGMENT_LABEL;
  phones: string[];
  image: { url?: string; base64?: string; mime?: string };
  ref?: string | null;
}

/**
 * Campanha vinda da "arte de post" do painel: guarda a arte, marca o público (varejo/atacado)
 * e cria um RASCUNHO. Nada sai até a administradora abrir a campanha no hub e iniciar.
 */
export async function createPainelCampaign(deps: Deps, input: PainelCampaignInput) {
  if (input.ref) {
    const prev = await deps.db.campaign.findFirst({ where: { source: 'painel', sourceRef: input.ref } });
    if (prev) return { campaignId: prev.id, duplicate: true, ...(await summary(deps, prev.id)) };
  }
  const cfg = await getSiteConfig(deps.db);
  const number = await deps.db.phoneNumber.findFirst({ where: { isActive: true, role: { in: ['CAMPAIGNS', 'BOTH'] } }, orderBy: { createdAt: 'asc' } });
  if (!number) throw new HttpError(503, 'Nenhum número de campanha ativo no hub.');
  const tpl = await deps.db.template.findFirst({ where: { name: cfg.campaignTemplate, wabaId: number.wabaId, status: 'APPROVED' } });
  if (!tpl) throw badRequest(`O template de campanha "${cfg.campaignTemplate}" ainda não está aprovado. Crie em Integração com o site.`);

  // arte: link https do painel ou o arquivo (guardado aqui e servido num link público aleatório)
  let artUrl = input.image.url ?? null;
  if (input.image.base64) {
    const data = Buffer.from(input.image.base64, 'base64');
    const mime = input.image.mime ?? 'image/jpeg';
    if (!/^image\/(jpeg|png)$/.test(mime)) throw badRequest('image.mime: use image/jpeg ou image/png (o WhatsApp só aceita esses).');
    if (!data.length || data.length > 5 * 1024 * 1024) throw badRequest('image.base64 vazio ou acima de 5 MB.');
    const id = randomBytes(16).toString('hex');
    await deps.db.campaignArt.create({ data: { id, mime, data } });
    artUrl = `${deps.env.PANEL_URL.replace(/\/$/, '')}/api/public/art/${id}`;
  }
  if (!artUrl) throw badRequest('Envie a arte: image.url (https) ou image.base64.');

  // público: as pessoas da lista do painel + a marca Varejo/Atacado (fica para as próximas)
  const valid = [...new Set(input.phones.map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)))];
  const invalid = input.phones.length - valid.length;
  const label = SEGMENT_LABEL[input.segment];
  const stamp = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const listTag = await deps.db.tag.upsert({ where: { name: `Painel · ${input.name} · ${label} · ${stamp}`.slice(0, 80) }, create: { name: `Painel · ${input.name} · ${label} · ${stamp}`.slice(0, 80), color: '#7c3a5e' }, update: {} });
  const segTag = input.segment === 'todos' ? null : await deps.db.tag.upsert({ where: { name: label }, create: { name: label, color: input.segment === 'varejo' ? '#2f7d5b' : '#8a5a12' }, update: {} });
  for (const phone of valid) {
    const c = await deps.db.contact.upsert({ where: { phone }, create: { phone }, update: {} });
    await deps.db.contactTag.createMany({ data: [{ contactId: c.id, tagId: listTag.id }, ...(segTag ? [{ contactId: c.id, tagId: segTag.id }] : [])], skipDuplicates: true });
  }

  const campaign = await createCampaign(deps, {
    name: `${input.name} · ${label}`.slice(0, 120),
    phoneNumberId: number.id,
    templateId: tpl.id,
    segment: { tagsAny: [listTag.id], tagsAll: [], excludeTags: [] },
    variables: { header: [], body: [{ source: 'firstName', fallback: 'cliente' }, { source: 'text', value: input.text }] },
    headerMediaUrl: artUrl,
    scheduledAt: null,
    windowStartHour: 9,
    windowEndHour: 20,
  });
  await deps.db.campaign.update({ where: { id: campaign.id }, data: { source: 'painel', sourceRef: input.ref ?? null } });
  log.info({ campanha: campaign.id, publico: valid.length, segmento: input.segment }, 'Campanha recebida do painel (aguardando aprovação)');
  return { campaignId: campaign.id, duplicate: false, invalidPhones: invalid, ...(await summary(deps, campaign.id)) };
}

async function summary(deps: Deps, campaignId: string) {
  const c = await deps.db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const est = await estimateAudience(deps, { tagsAny: (c.segment as { tagsAny: string[] }).tagsAny, tagsAll: [], excludeTags: [] }, { phoneNumberId: c.phoneNumberId });
  return {
    status: c.status,
    approvalUrl: `${deps.env.PANEL_URL.replace(/\/$/, '')}/campanhas/${c.id}`,
    audience: est,
  };
}
