import { randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'oh_session';

/** Cria a sessão; devolve o token (vai só no cookie — no banco fica o hash). */
export async function createSession(
  db: PrismaClient,
  userId: string,
  ttlHours: number,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.session.create({
    data: { id: sha256(token), userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
  });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { token, expiresAt };
}

export async function getSessionUser(db: PrismaClient, token: string | undefined): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const s = await db.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!s || !s.user.active) return null;
  if (s.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: s.id } }).catch(() => undefined);
    return null;
  }
  return s.user;
}

export async function destroySession(db: PrismaClient, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { id: sha256(token) } });
}

export async function destroyAllSessions(db: PrismaClient, userId: string, exceptToken?: string): Promise<void> {
  await db.session.deleteMany({ where: { userId, ...(exceptToken ? { NOT: { id: sha256(exceptToken) } } : {}) } });
}
