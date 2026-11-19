import type { Prisma, PrismaClient } from '@prisma/client';

/** Chaves de configuração globais editáveis pelo painel. */
export const SETTINGS = {
  botEnabled: 'bot.enabled',
  campaignMinDaysBetween: 'campaign.minDaysBetween',
  businessHours: 'business.hours',
} as const;

export async function getSetting<T>(db: PrismaClient, key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  return row ? (row.value as T) : fallback;
}

export async function setSetting(db: PrismaClient, key: string, value: unknown): Promise<void> {
  const json = value as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
}
