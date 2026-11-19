import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../lib/crypto.js';

/**
 * TOTP (RFC 6238): o mesmo padrão do Google Authenticator, Microsoft Authenticator, Authy, 1Password…
 * Código de 6 dígitos, troca a cada 30 s, HMAC-SHA1. Aceita 1 passo de diferença no relógio.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, como recomenda a RFC 4226. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const stepAt = (now: number) => Math.floor(now / 1000 / TOTP_PERIOD);

export function totpAt(secret: string, now = Date.now()): string {
  return hotp(secret, stepAt(now));
}

/**
 * Confere o código. Devolve o passo aceito (para bloquear reuso) ou null.
 * `lastStep`: passo do último código aceito — o mesmo código (ou um mais antigo) não vale de novo.
 */
export function verifyTotp(secret: string, code: string, opts: { now?: number; lastStep?: number | null; window?: number } = {}): number | null {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== DIGITS) return null;
  const current = stepAt(opts.now ?? Date.now());
  const win = opts.window ?? 1;
  for (let d = -win; d <= win; d++) {
    const step = current + d;
    if (opts.lastStep != null && step <= opts.lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Oliver Hub'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ── Códigos de recuperação (para quando perder o celular) ──

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem 0/o, 1/l/i

/** 10 códigos no formato xxxxx-xxxxx. Só os hashes ficam no banco. */
export function generateRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const part = () => Array.from({ length: 5 }, () => RC_ALPHABET[randomInt(RC_ALPHABET.length)]).join('');
    return `${part()}-${part()}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export function normalizeRecoveryCode(code: string): string {
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

export function hashRecoveryCode(code: string): string {
  return sha256(`oliver-hub-recovery:${normalizeRecoveryCode(code)}`);
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code.trim());
}
