import { Badge } from '@/components/ui/badge';
import type { CampaignStatus } from '@/lib/types';
import { cn, fmtInt } from '@/lib/utils';

const STATUS: Record<CampaignStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand' }> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  SCHEDULED: { label: 'Agendada', tone: 'brand' },
  RUNNING: { label: 'Enviando', tone: 'success' },
  PAUSED: { label: 'Pausada', tone: 'warning' },
  COMPLETED: { label: 'Concluída', tone: 'neutral' },
  CANCELED: { label: 'Cancelada', tone: 'danger' },
};

export function CampaignStatusBadge({ status, waiting }: { status: CampaignStatus; waiting?: boolean }) {
  const s = STATUS[status];
  return (
    <Badge tone={status === 'RUNNING' && waiting ? 'warning' : s.tone}>
      {status === 'RUNNING' && <span className={cn('size-1.5 rounded-full bg-current', !waiting && 'animate-pulse')} aria-hidden />}
      {status === 'RUNNING' && waiting ? 'Aguardando' : s.label}
    </Badge>
  );
}

/** Barra de progresso: enviados / falhas / pulados sobre o total. */
export function ProgressBar({ total, sent, failed, skipped }: { total: number; sent: number; failed: number; skipped: number }) {
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${fmtInt(sent)} de ${fmtInt(total)} enviados`}>
      <span className="bg-primary" style={{ width: pct(sent) }} />
      <span className="bg-[oklch(0.62_0.17_25)]" style={{ width: pct(failed) }} />
      <span className="bg-[oklch(0.8_0.02_280)]" style={{ width: pct(skipped) }} />
    </div>
  );
}

export function Metric({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'danger' | 'muted' }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('font-display text-2xl font-semibold tabular-nums', tone === 'danger' && value > 0 && 'text-[oklch(0.5_0.17_25)]', tone === 'muted' && 'text-muted-foreground')}>
        {fmtInt(value)}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const pctOf = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

export const HOURS = Array.from({ length: 14 }, (_, i) => i + 8); // 8..21
