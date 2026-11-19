import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.js';

/**
 * Base de conhecimento do bot. O arquivo knowledge/oliver.md é o conteúdo inicial; as edições feitas
 * pelo painel ficam versionadas no banco (KnowledgeVersion) e a mais recente é a que vale.
 */

export const KNOWLEDGE_MAX_CHARS = 60_000;

export function knowledgeFilePath(env: Env): string | null {
  const candidates = [
    env.KNOWLEDGE_FILE,
    path.resolve(process.cwd(), 'knowledge/oliver.md'),
    path.resolve(process.cwd(), '../../knowledge/oliver.md'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function readKnowledgeFile(env: Env): string {
  const file = knowledgeFilePath(env);
  return file ? readFileSync(file, 'utf8') : '';
}

export interface KnowledgeState {
  content: string;
  source: 'painel' | 'arquivo' | 'vazio';
  updatedAt: Date | null;
  versionId: string | null;
}

export async function getKnowledge(db: PrismaClient, env: Env): Promise<KnowledgeState> {
  const latest = await db.knowledgeVersion.findFirst({ orderBy: { createdAt: 'desc' } });
  if (latest) return { content: latest.content, source: 'painel', updatedAt: latest.createdAt, versionId: latest.id };
  const file = readKnowledgeFile(env);
  return { content: file, source: file ? 'arquivo' : 'vazio', updatedAt: null, versionId: null };
}

export async function saveKnowledge(db: PrismaClient, content: string, note?: string | null) {
  const clean = content.replace(/\r\n/g, '\n').trim();
  if (clean.length > KNOWLEDGE_MAX_CHARS) throw new Error(`A base de conhecimento passou de ${KNOWLEDGE_MAX_CHARS} caracteres.`);
  const v = await db.knowledgeVersion.create({ data: { content: `${clean}\n`, note: note?.trim() || null } });
  // guarda só as 30 versões mais recentes
  const old = await db.knowledgeVersion.findMany({ orderBy: { createdAt: 'desc' }, skip: 30, select: { id: true } });
  if (old.length) await db.knowledgeVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return v;
}

/** Itens [DEFINIR] ainda pendentes (para mostrar no painel). */
export function pendingPlaceholders(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.includes('[DEFINIR')) continue;
    out.push(line.replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '').trim());
  }
  return out;
}
