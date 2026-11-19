import type { ConsentAction, PrismaClient } from '@prisma/client';
import type { Deps } from '../deps.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { childLogger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { HEADER_ALIASES, normalizeHeader, parseBool, parseCsv, splitTags } from './csv.js';
import { segmentWhere, type Segment } from './segment.js';

const log = childLogger('contacts');

export const MAX_IMPORT_ROWS = 20_000;

export interface ImportOptions {
  csv: string;
  /** tags aplicadas a todas as linhas, além das do arquivo */
  defaultTags?: string[];
  /** origem do consentimento, obrigatória quando alguma linha marca opt-in (ex.: "cadastro loja física 2026") */
  optInSource?: string;
  /** marcar todas as linhas como opt-in (exige optInSource) */
  allOptIn?: boolean;
  dryRun?: boolean;
}

export interface ImportRow {
  line: number;
  name: string | null;
  phone: string;
  email: string | null;
  tags: string[];
  optIn: boolean;
}

export interface ImportReport {
  totalLines: number;
  valid: number;
  created: number;
  updated: number;
  optInMarked: number;
  skippedOptOut: number; // pediu para sair antes: o CSV NÃO reativa
  rejected: { line: number; value: string; reason: string }[];
  columns: Record<string, string | null>;
  preview: ImportRow[];
  dryRun: boolean;
}

function mapColumns(header: string[]) {
  const norm = header.map(normalizeHeader);
  const find = (aliases: string[]) => {
    const i = norm.findIndex((h) => aliases.some((a) => h === normalizeHeader(a)));
    return i >= 0 ? i : -1;
  };
  return {
    name: find(HEADER_ALIASES.name),
    phone: find(HEADER_ALIASES.phone),
    tags: find(HEADER_ALIASES.tags),
    optIn: find(HEADER_ALIASES.optIn),
    email: find(HEADER_ALIASES.email),
  };
}

/** Lê e valida o CSV; não grava nada. */
export function parseImport(opts: ImportOptions): { rows: ImportRow[]; report: Omit<ImportReport, 'created' | 'updated' | 'optInMarked' | 'skippedOptOut' | 'dryRun' | 'preview'> } {
  const table = parseCsv(opts.csv);
  if (table.length < 2) throw badRequest('O arquivo precisa ter um cabeçalho e pelo menos uma linha.');
  if (table.length - 1 > MAX_IMPORT_ROWS) throw badRequest(`Máximo de ${MAX_IMPORT_ROWS} linhas por importação.`);
  const header = table[0]!;
  const cols = mapColumns(header);
  if (cols.phone < 0) {
    throw badRequest('Não encontrei a coluna de telefone. Use um cabeçalho como "telefone", "celular" ou "whatsapp".');
  }

  const rejected: ImportReport['rejected'] = [];
  const seen = new Map<string, number>();
  const rows: ImportRow[] = [];
  const defaultTags = (opts.defaultTags ?? []).map((t) => t.trim()).filter(Boolean);

  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2; // linha 1 é o cabeçalho
    const rawPhone = (cells[cols.phone] ?? '').trim();
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      rejected.push({ line, value: rawPhone || '(vazio)', reason: rawPhone ? 'telefone inválido' : 'telefone vazio' });
      return;
    }
    if (seen.has(phone)) {
      rejected.push({ line, value: rawPhone, reason: `duplicado (mesmo número da linha ${seen.get(phone)})` });
      return;
    }
    let optIn = Boolean(opts.allOptIn);
    if (!optIn && cols.optIn >= 0) {
      const b = parseBool(cells[cols.optIn]);
      if (b === null) {
        rejected.push({ line, value: cells[cols.optIn] ?? '', reason: 'opt-in não reconhecido (use sim/não)' });
        return;
      }
      optIn = b;
    }
    const email = cols.email >= 0 ? (cells[cols.email] ?? '').trim() || null : null;
    seen.set(phone, line);
    rows.push({
      line,
      phone,
      name: cols.name >= 0 ? (cells[cols.name] ?? '').trim().slice(0, 120) || null : null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 200) : null,
      tags: [...new Set([...defaultTags, ...(cols.tags >= 0 ? splitTags(cells[cols.tags]) : [])])],
      optIn,
    });
  });

  if (rows.some((r) => r.optIn) && !opts.optInSource?.trim()) {
    throw badRequest('Informe a origem do consentimento (ex.: "cadastro no site", "loja física") — é obrigatória para registrar opt-in.');
  }

  const columnName = (i: number) => (i >= 0 ? (header[i] ?? null) : null);
  return {
    rows,
    report: {
      totalLines: table.length - 1,
      valid: rows.length,
      rejected,
      columns: {
        telefone: columnName(cols.phone),
        nome: columnName(cols.name),
        tags: columnName(cols.tags),
        optIn: columnName(cols.optIn),
        email: columnName(cols.email),
      },
    },
  };
}

async function ensureTags(db: PrismaClient, names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of [...new Set(names)]) {
    const tag = await db.tag.upsert({ where: { name }, create: { name }, update: {} });
    map.set(name, tag.id);
  }
  return map;
}

export async function importContacts(deps: Deps, opts: ImportOptions): Promise<ImportReport> {
  const { rows, report } = parseImport(opts);
  const source = `csv:${(opts.optInSource ?? '').trim()}`.slice(0, 120);
  const existing = await deps.db.contact.findMany({
    where: { phone: { in: rows.map((r) => r.phone) } },
    select: { id: true, phone: true, name: true, email: true, optIn: true, optOut: true },
  });
  const byPhone = new Map(existing.map((c) => [c.phone, c]));

  let created = 0;
  let updated = 0;
  let optInMarked = 0;
  let skippedOptOut = 0;
  for (const r of rows) {
    const ex = byPhone.get(r.phone);
    if (!ex) created++;
    else updated++;
    if (r.optIn) {
      if (ex?.optOut) skippedOptOut++;
      else if (!ex?.optIn) optInMarked++;
    }
  }

  const result: ImportReport = { ...report, created, updated, optInMarked, skippedOptOut, preview: rows.slice(0, 10), dryRun: Boolean(opts.dryRun) };
  if (opts.dryRun) return result;

  const tagIds = await ensureTags(deps.db, rows.flatMap((r) => r.tags));
  const now = new Date();
  for (const r of rows) {
    const ex = byPhone.get(r.phone);
    // Nunca reativa quem pediu para sair; nunca tira um opt-in existente.
    const grantOptIn = r.optIn && !ex?.optOut && !ex?.optIn;
    await deps.db.$transaction(async (tx) => {
      const c = ex
        ? await tx.contact.update({
            where: { id: ex.id },
            data: {
              ...(!ex.name && r.name ? { name: r.name } : {}),
              ...(!ex.email && r.email ? { email: r.email } : {}),
              ...(grantOptIn ? { optIn: true, optInAt: now, optInSource: source } : {}),
            },
          })
        : await tx.contact.create({
            data: {
              phone: r.phone,
              name: r.name,
              email: r.email,
              ...(grantOptIn ? { optIn: true, optInAt: now, optInSource: source } : {}),
            },
          });
      if (grantOptIn) {
        await tx.consentLog.create({ data: { contactId: c.id, action: 'OPT_IN', source, detail: `importação CSV, linha ${r.line}` } });
      }
      if (r.tags.length) {
        await tx.contactTag.createMany({
          data: r.tags.map((t) => ({ contactId: c.id, tagId: tagIds.get(t)! })),
          skipDuplicates: true,
        });
      }
    });
  }
  log.info({ created, updated, optInMarked, rejected: report.rejected.length }, 'Importação de contatos concluída');
  return result;
}

export async function listContacts(deps: Deps, segment: Segment, page: number, pageSize: number) {
  const where = segmentWhere(segment);
  const [total, contacts] = await Promise.all([
    deps.db.contact.count({ where }),
    deps.db.contact.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { tags: { include: { tag: true } } },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    contacts: contacts.map(({ tags, ...c }) => ({ ...c, tags: tags.map((t) => t.tag) })),
  };
}

export async function getContactDetail(deps: Deps, id: string) {
  const c = await deps.db.contact.findUnique({
    where: { id },
    include: {
      tags: { include: { tag: true } },
      consentLogs: { orderBy: { createdAt: 'desc' } },
      conversations: { include: { phoneNumber: { select: { id: true, displayName: true } } }, orderBy: { lastMessageAt: 'desc' } },
    },
  });
  if (!c) throw notFound('Contato não encontrado');
  const { tags, ...rest } = c;
  return { ...rest, tags: tags.map((t) => t.tag) };
}

export async function setContactTags(deps: Deps, contactId: string, tagIds: string[]) {
  await deps.db.$transaction([
    deps.db.contactTag.deleteMany({ where: { contactId, tagId: { notIn: tagIds } } }),
    deps.db.contactTag.createMany({ data: tagIds.map((tagId) => ({ contactId, tagId })), skipDuplicates: true }),
  ]);
}

/** Registro manual de consentimento pelo painel (ex.: cliente pediu no balcão). */
export async function recordConsent(deps: Deps, contactId: string, action: ConsentAction, source: string, detail?: string) {
  const c = await deps.db.contact.findUnique({ where: { id: contactId } });
  if (!c) throw notFound('Contato não encontrado');
  const now = new Date();
  await deps.db.$transaction([
    deps.db.contact.update({
      where: { id: contactId },
      data:
        action === 'OPT_IN'
          ? { optIn: true, optInAt: now, optInSource: `painel:${source}`, optOut: false, optOutAt: null }
          : { optOut: true, optOutAt: now },
    }),
    deps.db.consentLog.create({ data: { contactId, action, source: `painel:${source}`, detail } }),
    ...(action === 'OPT_OUT'
      ? [deps.db.campaignRecipient.updateMany({ where: { contactId, status: 'PENDING' }, data: { status: 'OPTED_OUT', skipReason: 'opt-out' } })]
      : []),
  ]);
}

/** LGPD: todos os dados que temos do contato, em JSON. */
export async function exportContactData(deps: Deps, id: string) {
  const c = await deps.db.contact.findUnique({
    where: { id },
    include: {
      tags: { include: { tag: { select: { name: true } } } },
      consentLogs: { orderBy: { createdAt: 'asc' } },
      conversations: {
        include: {
          phoneNumber: { select: { displayName: true, displayPhone: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            select: { direction: true, type: true, body: true, templateName: true, status: true, sentBy: true, createdAt: true },
          },
        },
      },
      campaignRecipients: { include: { campaign: { select: { name: true } } } },
    },
  });
  if (!c) throw notFound('Contato não encontrado');
  return {
    exportadoEm: new Date().toISOString(),
    controlador: 'Oliver Cosmetics LTDA — CNPJ 50.067.419/0001-39',
    contato: {
      telefone: c.phone,
      nome: c.name,
      email: c.email,
      documento: c.document,
      criadoEm: c.createdAt,
      optIn: c.optIn,
      optInEm: c.optInAt,
      optInOrigem: c.optInSource,
      optOut: c.optOut,
      optOutEm: c.optOutAt,
      tags: c.tags.map((t) => t.tag.name),
    },
    historicoConsentimento: c.consentLogs.map((l) => ({ acao: l.action, origem: l.source, detalhe: l.detail, em: l.createdAt })),
    campanhasRecebidas: c.campaignRecipients.map((r) => ({ campanha: r.campaign.name, status: r.status, enviadaEm: r.sentAt })),
    conversas: c.conversations.map((conv) => ({
      numeroDaEmpresa: conv.phoneNumber.displayPhone ?? conv.phoneNumber.displayName,
      mensagens: conv.messages,
    })),
  };
}

/** LGPD: exclusão definitiva do contato e de todo o histórico (mensagens, consentimentos, tags). */
export async function deleteContactData(deps: Deps, id: string, confirmPhone: string) {
  const c = await deps.db.contact.findUnique({ where: { id } });
  if (!c) throw notFound('Contato não encontrado');
  if (normalizePhone(confirmPhone) !== c.phone) throw new HttpError(400, 'Para confirmar, digite o telefone do contato.');
  await deps.db.contact.delete({ where: { id } }); // cascata: conversas, mensagens, consentimentos, tags, campanhas
  log.warn({ contactId: id }, 'Contato excluído a pedido (LGPD)');
}
