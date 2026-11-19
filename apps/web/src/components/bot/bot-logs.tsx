'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { WaText } from '@/components/wa-text';
import { fetcher } from '@/lib/api';
import type { BotLogItem } from '@/lib/types';
import { cn, fmtDateTime, fmtInt } from '@/lib/utils';
import { TokenLine, ToolChips } from './tool-chips';

const FILTERS = [
  { key: '', label: 'Todas' },
  { key: 'problems=true', label: 'Com erro ou transferência' },
  { key: 'simulated=false', label: 'WhatsApp' },
  { key: 'simulated=true', label: 'Simulador' },
] as const;

interface LogsResponse {
  logs: BotLogItem[];
  total: number;
  page: number;
  pageSize: number;
  last30Days: { replies: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export function BotLogs() {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useSWR<LogsResponse>(`/bot/logs?page=${page}${filter ? `&${filter}` : ''}`, fetcher, { refreshInterval: 15_000 });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const t = data?.last30Days;

  return (
    <div className="grid gap-4">
      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: 'Respostas (30 dias)', value: fmtInt(t.replies) },
            { label: 'Tokens de entrada', value: fmtInt(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens) },
            { label: 'Vindos do cache', value: fmtInt(t.cacheReadTokens) },
            { label: 'Tokens de saída', value: fmtInt(t.outputTokens) },
          ].map((s) => (
            <Card key={s.label} className="p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-xl font-semibold">{s.value}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {data?.logs.length === 0 && <Card className="border-dashed p-8 text-center text-sm text-muted-foreground">Nenhuma resposta registrada ainda.</Card>}

      <div className="grid gap-2">
        {data?.logs.map((log) => (
          <Card key={log.id} className="grid gap-2 p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{fmtDateTime(log.createdAt)}</span>
                {log.simulated ? (
                  <Badge>Simulador</Badge>
                ) : log.conversation ? (
                  <Link href={`/inbox?c=${log.conversation.id}`} className="truncate text-primary underline-offset-4 hover:underline">
                    {log.conversation.contact.name ?? log.conversation.contact.phone}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">conversa excluída</span>
                )}
                {log.handoff && <Badge tone="warning">Transferiu</Badge>}
                {log.error && <Badge tone="danger">Erro</Badge>}
              </div>
              <TokenLine log={log} />
            </div>
            {log.toolsCalled.length > 0 && <ToolChips log={log} />}
            {log.replyText && (
              <p className="line-clamp-4 rounded-md bg-muted/50 px-3 py-2 text-sm">
                <WaText text={log.replyText} />
              </p>
            )}
            {log.error && <p className="text-xs text-destructive">{log.error}</p>}
          </Card>
        ))}
      </div>

      {data && pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {page} de {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}
