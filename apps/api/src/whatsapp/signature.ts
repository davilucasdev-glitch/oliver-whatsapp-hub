import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida o cabeçalho X-Hub-Signature-256 ("sha256=<hex>") enviado pela Meta,
 * calculado como HMAC-SHA256 do corpo BRUTO com o App Secret.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algo, received] = header.split('=');
  if (algo !== 'sha256' || !received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
