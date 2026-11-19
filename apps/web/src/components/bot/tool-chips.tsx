import { cn, fmtInt } from '@/lib/utils';
import type { BotLogItem } from '@/lib/types';

export const TOOL_LABEL: Record<string, string> = {
  buscar_produtos: 'buscou produtos',
  detalhes_produto: 'abriu a ficha',
  consultar_pedido: 'consultou pedido',
  transferir_para_humano: 'transferiu',
  enviar_imagem_produto: 'enviou foto',
};

function inputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

export function ToolChips({ log, className }: { log: BotLogItem; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {log.toolsCalled.map((t, i) => (
        <span
          key={i}
          title={inputSummary(t.input)}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            !t.ok ? 'bg-danger-soft text-[oklch(0.45_0.17_25)]' : t.outcome === 'not_found' ? 'bg-warning-soft text-[oklch(0.45_0.11_60)]' : 'bg-secondary text-secondary-foreground',
          )}
        >
          {TOOL_LABEL[t.name] ?? t.name}
          {t.outcome === 'not_found' ? ' (nada)' : ''}
        </span>
      ))}
    </div>
  );
}

export function TokenLine({ log }: { log: BotLogItem }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      {fmtInt(log.inputTokens + log.cacheReadTokens + log.cacheWriteTokens)} tokens de entrada
      {log.cacheReadTokens > 0 ? ` (${fmtInt(log.cacheReadTokens)} do cache)` : ''} · {fmtInt(log.outputTokens)} de saída · {(log.latencyMs / 1000).toFixed(1)} s
      {log.iterations > 1 ? ` · ${log.iterations} chamadas` : ''}
    </span>
  );
}
