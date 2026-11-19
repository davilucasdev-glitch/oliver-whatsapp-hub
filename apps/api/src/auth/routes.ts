import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { HttpError, parse } from '../http/errors.js';
import QRCode from 'qrcode';
import { decrypt, encrypt, sha256 } from '../lib/crypto.js';
import { childLogger } from '../lib/logger.js';
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from './password.js';
import { createSession, destroyAllSessions, destroySession, getSessionUser, SESSION_COOKIE } from './session.js';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, looksLikeRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;

const log = childLogger('auth');

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

/** Cabeçalho que só o painel manda; navegadores não o enviam em requisições cross-site sem CORS. */
export const CSRF_HEADER = 'x-oliver-panel';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('e-mail inválido').max(200),
  password: z.string().min(1, 'informe a senha').max(128),
});

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name || u.email.split('@')[0]!, role: u.role, twoFactor: Boolean(u.totpSecret) };
}

function recoveryList(u: User): string[] {
  return Array.isArray(u.recoveryCodes) ? (u.recoveryCodes as string[]) : [];
}

/**
 * Confere o segundo fator: código do app (6 dígitos) ou código de recuperação (uso único).
 * Grava o passo aceito / remove o código usado. Devolve como foi aceito, ou null.
 */
async function checkSecondFactor(deps: Deps, user: User, code: string): Promise<'totp' | 'recovery' | null> {
  if (!user.totpSecret) return null;
  if (looksLikeRecoveryCode(code)) {
    const list = recoveryList(user);
    const h = hashRecoveryCode(code);
    if (!list.includes(h)) return null;
    // atualização condicional: o mesmo código não serve duas vezes nem em requisições simultâneas
    const res = await deps.db.user.updateMany({
      where: { id: user.id, recoveryCodes: { equals: list } },
      data: { recoveryCodes: list.filter((x) => x !== h) },
    });
    return res.count ? 'recovery' : null;
  }
  const secret = decrypt(user.totpSecret, deps.env.ENCRYPTION_KEY);
  const step = verifyTotp(secret, code, { lastStep: user.totpLastStep });
  if (step === null) return null;
  const res = await deps.db.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return res.count ? 'totp' : null;
}

export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: deps.env.COOKIE_SECURE,
    expires: expiresAt,
  });
}

/** preHandler: exige sessão válida e, em métodos que alteram dados, o cabeçalho anti-CSRF. */
export function requireAuth(deps: Deps) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[CSRF_HEADER] !== '1') {
      throw new HttpError(403, 'Requisição recusada (CSRF)');
    }
    const user = await getSessionUser(deps.db, req.cookies[SESSION_COOKIE]);
    if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
    req.user = user;
  };
}

export async function authRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const loginLimit = { max: deps.env.LOGIN_RATE_LIMIT, timeWindow: '15 minutes' };

  app.get('/auth/status', async (req) => {
    const users = await deps.db.user.count();
    const user = await getSessionUser(deps.db, req.cookies[SESSION_COOKIE]);
    return { setupRequired: users === 0, user: user ? publicUser(user) : null };
  });

  /** Primeiro acesso: só funciona enquanto não existe usuário e exige SETUP_TOKEN do .env. */
  app.post('/auth/setup', { config: { rateLimit: loginLimit } }, async (req, reply) => {
    const body = parse(credentials.extend({ setupToken: z.string().min(1, 'informe o código de instalação') }), req.body);
    if (!deps.env.SETUP_TOKEN) throw new HttpError(503, 'Defina SETUP_TOKEN no .env para criar o primeiro acesso.');
    if (!safeEqual(body.setupToken, deps.env.SETUP_TOKEN)) throw new HttpError(403, 'Código de instalação incorreto.');
    if ((await deps.db.user.count()) > 0) throw new HttpError(409, 'O acesso já foi criado. Faça login.');
    const problem = passwordProblems(body.password);
    if (problem) throw new HttpError(400, problem);

    const user = await deps.db.user.create({ data: { email: body.email, role: 'ADMIN', passwordHash: await hashPassword(body.password) } });
    const s = await createSession(deps.db, user.id, deps.env.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(deps, reply, s.token, s.expiresAt);
    log.info({ email: user.email }, 'Primeiro acesso criado');
    return { user: publicUser(user) };
  });

  app.post('/auth/login', { config: { rateLimit: loginLimit } }, async (req, reply) => {
    const body = parse(credentials, req.body);
    const user = await deps.db.user.findUnique({ where: { email: body.email } });
    // Compara mesmo sem usuário, para não revelar quais e-mails existem pelo tempo de resposta.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !ok) {
      log.warn({ email: body.email, ip: req.ip }, 'Login recusado');
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    if (!user.active) {
      log.warn({ email: body.email, ip: req.ip }, 'Login de acesso desativado');
      throw new HttpError(403, 'Este acesso foi desativado. Fale com o administrador do painel.');
    }
    if (user.totpSecret) {
      // senha certa, falta o código do app: devolve um desafio de 5 minutos (ainda sem sessão)
      const token = randomBytes(32).toString('base64url');
      await deps.db.loginChallenge.deleteMany({ where: { OR: [{ userId: user.id }, { expiresAt: { lt: new Date() } }] } });
      await deps.db.loginChallenge.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } });
      return { twoFactorRequired: true, challenge: token };
    }
    const s = await createSession(deps.db, user.id, deps.env.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(deps, reply, s.token, s.expiresAt);
    return { user: publicUser(user) };
  });

  app.post('/auth/login/2fa', { config: { rateLimit: loginLimit } }, async (req, reply) => {
    const body = parse(z.object({ challenge: z.string().min(10).max(100), code: z.string().trim().min(6, 'informe o código').max(20) }), req.body);
    const ch = await deps.db.loginChallenge.findUnique({ where: { id: sha256(body.challenge) }, include: { user: true } });
    if (!ch || ch.expiresAt < new Date() || ch.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      if (ch) await deps.db.loginChallenge.delete({ where: { id: ch.id } }).catch(() => undefined);
      throw new HttpError(401, 'O tempo para digitar o código acabou ou houve tentativas demais. Entre com a senha de novo.');
    }
    if (!ch.user.active) {
      await deps.db.loginChallenge.delete({ where: { id: ch.id } }).catch(() => undefined);
      throw new HttpError(403, 'Este acesso foi desativado. Fale com o administrador do painel.');
    }
    await deps.db.loginChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    const how = await checkSecondFactor(deps, ch.user, body.code);
    if (!how) {
      log.warn({ email: ch.user.email, ip: req.ip }, 'Código de verificação recusado');
      throw new HttpError(401, 'Código incorreto. Confira o app autenticador (ou use um código de recuperação).');
    }
    await deps.db.loginChallenge.delete({ where: { id: ch.id } });
    const s = await createSession(deps.db, ch.userId, deps.env.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(deps, reply, s.token, s.expiresAt);
    const fresh = await deps.db.user.findUniqueOrThrow({ where: { id: ch.userId } });
    if (how === 'recovery') log.warn({ email: fresh.email }, 'Login com código de recuperação');
    return { user: publicUser(fresh), usedRecoveryCode: how === 'recovery', recoveryCodesLeft: recoveryList(fresh).length };
  });

  // ── Segurança (precisa estar logado) ──
  const auth = { preHandler: requireAuth(deps) };
  const sensitive = { preHandler: requireAuth(deps), config: { rateLimit: loginLimit } };

  app.get('/auth/security', auth, async (req) => {
    const user = req.user!;
    const current = sha256(req.cookies[SESSION_COOKIE] ?? '');
    const sessions = await deps.db.session.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return {
      twoFactor: Boolean(user.totpSecret),
      twoFactorSince: user.totpEnabledAt,
      recoveryCodesLeft: recoveryList(user).length,
      sessions: sessions.map((s) => ({ id: s.id.slice(0, 12), ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.id === current })),
    };
  });

  app.post('/auth/sessions/revoke-others', auth, async (req) => {
    await destroyAllSessions(deps.db, req.user!.id, req.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  /** 1º passo: gera o segredo e o QR Code. Só vale depois de confirmar um código (enable). */
  app.post('/auth/2fa/setup', sensitive, async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1, 'informe a senha') }), req.body);
    const user = req.user!;
    if (user.totpSecret) throw new HttpError(409, 'A verificação em duas etapas já está ativa.');
    if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(400, 'Senha incorreta.');
    const secret = generateSecret();
    await deps.db.user.update({ where: { id: user.id }, data: { totpPendingEnc: encrypt(secret, deps.env.ENCRYPTION_KEY) } });
    const url = otpauthUrl(secret, user.email);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret: secret.match(/.{1,4}/g)!.join(' '), otpauthUrl: url, qrSvg };
  });

  /** 2º passo: confirma com o primeiro código do app e devolve os códigos de recuperação (só desta vez). */
  app.post('/auth/2fa/enable', sensitive, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6, 'informe o código de 6 dígitos').max(10) }), req.body);
    const user = req.user!;
    if (user.totpSecret) throw new HttpError(409, 'A verificação em duas etapas já está ativa.');
    if (!user.totpPendingEnc) throw new HttpError(400, 'Comece pelo QR Code (o processo não foi iniciado).');
    const secret = decrypt(user.totpPendingEnc, deps.env.ENCRYPTION_KEY);
    const step = verifyTotp(secret, code);
    if (step === null) throw new HttpError(400, 'Código incorreto. Confira se o relógio do celular está certo e digite o código atual.');
    const { codes, hashes } = generateRecoveryCodes();
    await deps.db.user.update({
      where: { id: user.id },
      data: { totpSecret: user.totpPendingEnc, totpPendingEnc: null, totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: hashes },
    });
    await destroyAllSessions(deps.db, user.id, req.cookies[SESSION_COOKIE]); // outras sessões precisam entrar com o código
    log.info({ email: user.email }, 'Verificação em duas etapas ativada');
    return { recoveryCodes: codes };
  });

  app.post('/auth/2fa/disable', sensitive, async (req) => {
    const body = parse(z.object({ password: z.string().min(1, 'informe a senha'), code: z.string().trim().min(6, 'informe o código').max(20) }), req.body);
    const user = req.user!;
    if (!user.totpSecret) throw new HttpError(409, 'A verificação em duas etapas não está ativa.');
    if (!(await verifyPassword(body.password, user.passwordHash))) throw new HttpError(400, 'Senha incorreta.');
    if (!(await checkSecondFactor(deps, user, body.code))) throw new HttpError(400, 'Código incorreto.');
    await deps.db.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: Prisma.DbNull },
    });
    log.warn({ email: user.email }, 'Verificação em duas etapas desativada');
    return { ok: true };
  });

  app.post('/auth/2fa/recovery-codes', sensitive, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6, 'informe o código do app').max(20) }), req.body);
    const user = req.user!;
    if (!user.totpSecret) throw new HttpError(409, 'A verificação em duas etapas não está ativa.');
    if ((await checkSecondFactor(deps, user, code)) !== 'totp') throw new HttpError(400, 'Código do app incorreto.');
    const { codes, hashes } = generateRecoveryCodes();
    await deps.db.user.update({ where: { id: user.id }, data: { recoveryCodes: hashes } });
    return { recoveryCodes: codes };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(deps.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/password', { preHandler: requireAuth(deps), config: { rateLimit: loginLimit } }, async (req) => {
    const body = parse(z.object({ current: z.string().min(1), next: z.string().min(1) }), req.body);
    const user = req.user!;
    if (!(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, 'Senha atual incorreta.');
    const problem = passwordProblems(body.next);
    if (problem) throw new HttpError(400, problem);
    await deps.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.next) } });
    await destroyAllSessions(deps.db, user.id, req.cookies[SESSION_COOKIE]); // derruba outras sessões
    return { ok: true };
  });
}
