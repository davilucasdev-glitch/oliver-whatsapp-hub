import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { decrypt, encrypt, sha256 } from '../lib/crypto.js';
import { getSetting, setSetting } from '../settings.js';

/**
 * Integração com o site/painel da Oliver (PHP na Hostinger). Documento da Ellen, "O que o hub
 * precisa expor": chave de acesso só do site (no cabeçalho, nunca na URL) + avisos de volta
 * para uma URL do site (mensagem recebida, status, opt-out), assinados com HMAC.
 */

export const SITE_EVENTS = ['message.received', 'message.status', 'contact.opt_out'] as const;
export type SiteEvent = (typeof SITE_EVENTS)[number];

export interface SiteConfig {
  /** hash SHA-256 da chave (a chave em si só aparece uma vez, ao gerar) */
  tokenHash: string | null;
  tokenPrefix: string | null;
  tokenCreatedAt: string | null;
  lastUsedAt: string | null;
  webhookUrl: string;
  /** segredo da assinatura dos avisos (criptografado) */
  webhookSecretEnc: string | null;
  events: SiteEvent[];
  /** template de marketing com imagem no cabeçalho usado nas campanhas do painel */
  campaignTemplate: string;
}

const KEY = 'site.integration';

export async function getSiteConfig(db: PrismaClient): Promise<SiteConfig> {
  const base: SiteConfig = {
    tokenHash: null,
    tokenPrefix: null,
    tokenCreatedAt: null,
    lastUsedAt: null,
    webhookUrl: '',
    webhookSecretEnc: null,
    events: [...SITE_EVENTS],
    campaignTemplate: 'campanha_arte',
  };
  const saved = await getSetting<Partial<SiteConfig> | null>(db, KEY, null);
  return saved ? { ...base, ...saved } : base;
}

export async function saveSiteConfig(db: PrismaClient, cfg: SiteConfig): Promise<void> {
  await setSetting(db, KEY, cfg);
}

/** Gera uma chave nova (a antiga deixa de valer). Devolve a chave em texto uma única vez. */
export async function rotateToken(db: PrismaClient): Promise<string> {
  const token = `oh_site_${randomBytes(24).toString('base64url')}`;
  const cfg = await getSiteConfig(db);
  await saveSiteConfig(db, { ...cfg, tokenHash: sha256(token), tokenPrefix: token.slice(0, 12), tokenCreatedAt: new Date().toISOString(), lastUsedAt: null });
  return token;
}

export function tokenMatches(cfg: SiteConfig, token: string | undefined): boolean {
  if (!cfg.tokenHash || !token) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(cfg.tokenHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function rotateWebhookSecret(db: PrismaClient, key: string): Promise<string> {
  const secret = randomBytes(24).toString('base64url');
  const cfg = await getSiteConfig(db);
  await saveSiteConfig(db, { ...cfg, webhookSecretEnc: encrypt(secret, key) });
  return secret;
}

export function webhookSecret(cfg: SiteConfig, key: string): string | null {
  return cfg.webhookSecretEnc ? decrypt(cfg.webhookSecretEnc, key) : null;
}
