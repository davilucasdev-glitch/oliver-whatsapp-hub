'use client';

import { Megaphone, Plus, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { CampaignStatusBadge, ProgressBar } from '@/components/campaigns/campaign-bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { CampaignListItem } from '@/lib/types';
import { cn, fmtDateTime, fmtInt } from '@/lib/utils';

const FILTERS = [
  { key: 'active', label: 'Em andamento', match: ['RUNNING', 'SCHEDULED', 'PAUSED'] },
  { key: 'draft', label: 'Rascunhos', match: ['DRAFT'] },
  { key: 'done', label: 'Encerradas', match: ['COMPLETED', 'CANCELED'] },
  { key: 'all', label: 'Todas', match: [] },
] as const;

function FrequencyDialog({ current, onDone }: { current: number; onDone: () => void }) {
  const [days, setDays] = useState(String(current));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api('/campaigns/settings', { method: 'PUT', body: { minDaysBetween: Number(days) } });
      toast.success('Regra salva');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Frequência por cliente</DialogTitle>
        <DialogDescription>Cada cliente recebe no máximo 1 campanha a cada X dias, somando todas as campanhas e números. Receber demais é o que mais gera denúncia e bloqueio.</DialogDescription>
      </DialogHeader>
      <Field label="Dias entre campanhas" htmlFor="freq" hint="Padrão recomendado: 7. Use 0 só se souber o que está fazendo.">
        <Input id="freq" type="number" min={0} max={60} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" />
      </Field>
      <DialogFooter>
        <Button onClick={() => void save()} loading={saving}>
          Salvar
        </Button>
      </DialogFooter>
    </>
  );
}

export default function CampanhasPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [freqOpen, setFreqOpen] = useState(false);
  const { data, error, mutate } = useSWR<{ campaigns: CampaignListItem[]; minDaysBetween: number }>('/campaigns', fetcher, {
    refreshInterval: (d) => (d?.campaigns.some((c) => c.status === 'RUNNING' || c.status === 'SCHEDULED') ? 4000 : 0),
  });
  const f = FILTERS.find((x) => x.key === filter)!;
  const list = (data?.campaigns ?? []).filter((c) => f.match.length === 0 || (f.match as readonly string[]).includes(c.status));

  return (
    <>
      <PageHeader
        title="Campanhas"
        description="Disparos por template aprovado, só para quem deu opt-in, no ritmo seguro de cada número."
        actions={
          <>
            <Button variant="outline" onClick={() => setFreqOpen(true)} disabled={!data}>
              <Settings2 /> 1 a cada {data?.minDaysBetween ?? 7} dias
            </Button>
            <Button asChild>
              <Link href="/campanhas/nova">
                <Plus /> Nova campanha
              </Link>
            </Button>
          </>
        }
      />

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((x) => (
          <button
            key={x.key}
            onClick={() => setFilter(x.key)}
            className={cn(
              'shrink-0 cursor-pointer rounded-full border px-3 py-1.5 text-sm font-semibold',
              filter === x.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-muted-foreground">{(error as Error).message}</p>}
      {data && list.length === 0 && (
        <Card className="grid place-items-center gap-3 px-6 py-14 text-center">
          <Megaphone className="size-8 text-muted-foreground" />
          <p className="font-semibold">{data.campaigns.length === 0 ? 'Nenhuma campanha ainda' : 'Nada neste filtro'}</p>
          {data.campaigns.length === 0 && (
            <p className="max-w-sm text-sm text-muted-foreground">Escolha um template aprovado, o público por tags e o horário. O sistema cuida do ritmo e das regras anti-bloqueio.</p>
          )}
        </Card>
      )}

      <div className="grid gap-3">
        {list.map((c) => {
          const done = c.counts.total - c.counts.pending;
          return (
            <Link key={c.id} href={`/campanhas/${c.id}`} className="block">
              <Card className="grid gap-3 p-4 transition-colors hover:bg-muted/40">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.template.name} · {c.phoneNumber.displayName}
                      {c.status === 'SCHEDULED' && c.scheduledAt ? ` · agendada para ${fmtDateTime(c.scheduledAt)}` : ''}
                      {c.status === 'DRAFT' ? ` · criada ${fmtDateTime(c.createdAt)}` : ''}
                      {c.startedAt && c.status !== 'SCHEDULED' ? ` · início ${fmtDateTime(c.startedAt)}` : ''}
                    </p>
                  </div>
                  <CampaignStatusBadge status={c.status} waiting={Boolean(c.waitingReason)} />
                </div>
                {c.counts.total > 0 && (
                  <>
                    <ProgressBar total={c.counts.total} sent={c.counts.sent} failed={c.counts.failed} skipped={c.counts.skipped} />
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        <b className="text-foreground">{fmtInt(c.counts.sent)}</b> enviados
                      </span>
                      <span>{fmtInt(c.counts.replied)} responderam</span>
                      {c.counts.failed > 0 && <span>{fmtInt(c.counts.failed)} falhas</span>}
                      <span>{fmtInt(c.counts.skipped)} pulados</span>
                      {c.counts.pending > 0 && <span>{fmtInt(c.counts.pending)} na fila</span>}
                      <span className="ml-auto">{Math.round((done / c.counts.total) * 100)}%</span>
                    </div>
                  </>
                )}
                {(c.pausedReason || c.waitingReason) && c.status !== 'COMPLETED' && (
                  <p className="text-xs text-[oklch(0.45_0.11_60)]">{c.status === 'PAUSED' ? c.pausedReason : c.waitingReason}</p>
                )}
              </Card>
            </Link>
          );
        })}
      </div>

      <Dialog open={freqOpen} onOpenChange={setFreqOpen}>
        <DialogContent>
          {data && (
            <FrequencyDialog
              current={data.minDaysBetween}
              onDone={() => {
                setFreqOpen(false);
                void mutate();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
