'use client';

import { Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { TemplateStatusBadge, WhatsAppBubble } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, fetcher } from '@/lib/api';
import type { Template } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';

const FILTERS = [
  { key: '', label: 'Todos' },
  { key: 'APPROVED', label: 'Aprovados' },
  { key: 'PENDING', label: 'Em análise' },
  { key: 'REJECTED', label: 'Rejeitados' },
] as const;

const CATEGORY: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' };

export default function TemplatesPage() {
  const [filter, setFilter] = useState<string>('');
  const { data, error, mutate } = useSWR<{ templates: Template[] }>(`/templates${filter ? `?status=${filter}` : ''}`, fetcher);
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api<{ total: number }>('/templates/sync', { method: 'POST' });
      toast.success(`${r.total} templates sincronizados com a Meta`);
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Templates"
        description="Mensagens ativas (campanhas e fora da janela de 24h) só podem usar templates aprovados pela Meta."
        actions={
          <>
            <Button variant="outline" onClick={sync} loading={syncing}>
              <RefreshCw /> Sincronizar com a Meta
            </Button>
            <Button asChild>
              <Link href="/templates/novo">
                <Plus /> Novo template
              </Link>
            </Button>
          </>
        }
      />

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
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
      {!data && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data?.templates.length === 0 && (
        <Card className="grid place-items-center gap-2 border-dashed p-10 text-center">
          <p className="font-semibold">Nenhum template {filter ? 'neste filtro' : 'ainda'}</p>
          <p className="max-w-sm text-sm text-muted-foreground">Clique em “Sincronizar com a Meta” para trazer os templates da sua conta, ou crie um novo.</p>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {data?.templates.map((t) => (
          <Card key={t.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold">{t.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t.language} · {t.variables.header + t.variables.body} variáve{t.variables.header + t.variables.body === 1 ? 'l' : 'is'} ·
                  atualizado {timeAgo(t.syncedAt)}
                </p>
              </div>
              <TemplateStatusBadge status={t.status} />
            </div>
            <div className="flex gap-1.5">
              <Badge tone="brand">{CATEGORY[t.category] ?? t.category}</Badge>
            </div>
            {t.rejectedReason && (
              <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-[oklch(0.45_0.17_25)]">Motivo da Meta: {t.rejectedReason}</p>
            )}
            <WhatsAppBubble text={t.preview} />
          </Card>
        ))}
      </div>
    </>
  );
}
