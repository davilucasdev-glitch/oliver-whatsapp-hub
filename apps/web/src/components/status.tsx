import { Badge } from '@/components/ui/badge';
import type { NumberRole, QualityRating } from '@/lib/types';

const QUALITY: Record<QualityRating, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  HIGH: { label: 'Qualidade alta', tone: 'success' },
  MEDIUM: { label: 'Qualidade média', tone: 'warning' },
  LOW: { label: 'Qualidade baixa', tone: 'danger' },
  UNKNOWN: { label: 'Qualidade ?', tone: 'neutral' },
};

export function QualityBadge({ rating }: { rating: QualityRating }) {
  const q = QUALITY[rating];
  return (
    <Badge tone={q.tone}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {q.label}
    </Badge>
  );
}

export const ROLE_LABEL: Record<NumberRole, string> = {
  ATTENDANCE: 'Atendimento',
  CAMPAIGNS: 'Campanhas',
  BOTH: 'Atendimento + campanhas',
};

const TEMPLATE_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  APPROVED: { label: 'Aprovado', tone: 'success' },
  PENDING: { label: 'Em análise', tone: 'warning' },
  IN_APPEAL: { label: 'Em recurso', tone: 'warning' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
  PAUSED: { label: 'Pausado', tone: 'danger' },
  DISABLED: { label: 'Desativado', tone: 'danger' },
  DELETED: { label: 'Excluído', tone: 'neutral' },
};

export function TemplateStatusBadge({ status }: { status: string }) {
  const s = TEMPLATE_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function connectionLabel(status: string): { label: string; ok: boolean } {
  switch (status) {
    case 'CONNECTED':
      return { label: 'Conectado', ok: true };
    case 'PENDING':
      return { label: 'Pendente', ok: false };
    case 'FLAGGED':
      return { label: 'Sinalizado', ok: false };
    case 'RESTRICTED':
      return { label: 'Restrito', ok: false };
    case 'ERROR':
      return { label: 'Erro ao consultar', ok: false };
    default:
      return { label: status === 'UNKNOWN' ? 'Não verificado' : status, ok: false };
  }
}

/** Balão no estilo WhatsApp para pré-visualizar mensagens (respeita *negrito* e _itálico_). */
export function WhatsAppBubble({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="rounded-xl bg-[oklch(0.93_0.03_150)] p-3">
      <div className="max-w-[320px] rounded-lg rounded-tl-none bg-white px-3 py-2 text-[14px] leading-relaxed text-[oklch(0.25_0.01_150)] shadow-sm">
        {lines.map((line, i) => {
          const button = /^\[ .+ \]( \[ .+ \])*$/.test(line);
          if (button) {
            return (
              <div key={i} className="mt-2 grid gap-1 border-t pt-2">
                {line.match(/\[ (.+?) \]/g)?.map((b) => (
                  <span key={b} className="text-center text-[13px] font-semibold text-[oklch(0.55_0.12_230)]">
                    {b.slice(2, -2)}
                  </span>
                ))}
              </div>
            );
          }
          const bold = /^\*(.+)\*$/.exec(line);
          const italic = /^_(.+)_$/.exec(line);
          if (bold) return <p key={i} className="font-semibold">{bold[1]}</p>;
          if (italic) return <p key={i} className="text-xs text-[oklch(0.5_0.01_150)]">{italic[1]}</p>;
          return line ? <p key={i} className="whitespace-pre-wrap">{line}</p> : <div key={i} className="h-2" />;
        })}
      </div>
    </div>
  );
}
