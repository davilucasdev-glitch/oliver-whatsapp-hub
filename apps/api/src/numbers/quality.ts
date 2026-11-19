import type { QualityRating } from '@prisma/client';

/** Meta devolve GREEN/YELLOW/RED; no painel usamos ALTA/MÉDIA/BAIXA. */
export function mapMetaQuality(value: string | undefined | null): QualityRating {
  switch ((value ?? '').toUpperCase()) {
    case 'GREEN':
    case 'HIGH':
      return 'HIGH';
    case 'YELLOW':
    case 'MEDIUM':
      return 'MEDIUM';
    case 'RED':
    case 'LOW':
    case 'FLAGGED':
      return 'LOW';
    default:
      return 'UNKNOWN';
  }
}

/** Limite diário de conversas iniciadas pela empresa, por tier. */
export function tierToDailyLimit(tier: string | undefined | null): number | null {
  if (!tier) return null;
  const t = tier.toUpperCase();
  if (t === 'TIER_UNLIMITED' || t === 'UNLIMITED') return 1_000_000;
  const m = /^TIER_(\d+)(K)?$/.exec(t);
  if (!m?.[1]) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

export interface QualityDecision {
  sendRatePerMinute: number;
  campaignsPaused: boolean;
  alert?: { level: 'INFO' | 'WARNING' | 'CRITICAL'; type: string; message: string };
}

/**
 * Política anti-bloqueio:
 *  - ALTA: ritmo normal (configurado)
 *  - MÉDIA: ritmo reduzido pela metade + alerta
 *  - BAIXA: pausa campanhas do número + alerta crítico
 */
export function decideQualityPolicy(
  rating: QualityRating,
  baseRate: number,
  displayName: string,
  previous?: QualityRating,
): QualityDecision {
  const changed = previous !== undefined && previous !== rating;
  switch (rating) {
    case 'LOW':
      return {
        sendRatePerMinute: Math.max(1, Math.floor(baseRate / 4)),
        campaignsPaused: true,
        alert: {
          level: 'CRITICAL',
          type: 'QUALITY_LOW',
          message: `Qualidade do número ${displayName} caiu para BAIXA. Campanhas deste número foram pausadas.`,
        },
      };
    case 'MEDIUM':
      return {
        sendRatePerMinute: Math.max(1, Math.floor(baseRate / 2)),
        campaignsPaused: false,
        ...(changed || previous === undefined
          ? {
              alert: {
                level: 'WARNING' as const,
                type: 'QUALITY_MEDIUM',
                message: `Qualidade do número ${displayName} está MÉDIA. O ritmo das campanhas foi reduzido pela metade.`,
              },
            }
          : {}),
      };
    case 'HIGH':
      return {
        sendRatePerMinute: baseRate,
        campaignsPaused: false,
        ...(changed && previous !== 'UNKNOWN'
          ? {
              alert: {
                level: 'INFO' as const,
                type: 'QUALITY_RECOVERED',
                message: `Qualidade do número ${displayName} voltou para ALTA. Ritmo normal restabelecido (campanhas pausadas precisam ser retomadas manualmente).`,
              },
            }
          : {}),
      };
    default:
      return { sendRatePerMinute: baseRate, campaignsPaused: false };
  }
}
