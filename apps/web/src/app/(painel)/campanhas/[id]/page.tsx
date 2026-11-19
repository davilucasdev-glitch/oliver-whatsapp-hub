'use client';

import { ArrowLeft, Ban, Copy, Download, Pause, Pencil, Play, Rocket, Send, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { CampaignStatusBadge, Metric, pctOf, ProgressBar } from '@/components/campaigns/campaign-bits';
import { displayName, formatPhone } from '@/components/contact-bits';
import { QualityBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { CampaignDetail, CampaignRecipientRow } from '@/lib/types';
import { cn, fmtDateTime, fmtInt } from '@/lib/utils';

const FILTERS = [
  { key: '', label: 'Todos' },
  { key: 'sent', label: 'Enviados' },
  { key: 'delivered', label: 'Entregues' },
  { key: 'read', label: 'Lidos' },
  { key: 'replied', label: 'Responderam' },
  { key: 'failed', label: 'Falhas' },
  { key: 'optOuts', label: 'Saíram' },
  { key: 'skipped', label: 'Pulados' },
  { key: 'pending', label: 'Na fila' },
] as const;

const RECIPIENT_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand' }> = {
  PENDING: { label: 'Na fila', tone: 'neutral' },
  SENDING: { label: 'Enviando', tone: 'brand' },
  SENT: { label: 'Enviado', tone: 'brand' },
  DELIVERED: { label: 'Entregue', tone: 'success' },
  READ: { label: 'Lido', tone: 'success' },
  REPLIED: { label: 'Respondeu', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  SKIPPED: { label: 'Pulado', tone: 'neutral' },
  OPTED_OUT: { label: 'Saiu', tone: 'warning' },
};

function Recipients({ id, refresh }: { id: string; refresh: number }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useSWR<{ total: number; pageSize: number; recipients: CampaignRecipientRow[] }>(
    `/campaigns/${id}/recipients?page=${page}${filter ? `&filter=${filter}` : ''}`,
    fetcher,
    { refreshInterval: refresh },
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Destinatários</CardTitle>
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/campaigns/${id}/recipients.csv`}>
            <Download /> CSV
          </a>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key);
                setPage(1);
              }}
              className={cn('shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-xs font-semibold', filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="divide-y rounded-lg border">
          {data?.recipients.map((r) => {
            const st = RECIPIENT_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <Link href={`/contatos/${r.contact.id}`} className="min-w-0 font-medium hover:underline">
                  {displayName(r.contact)}
                  {r.contact.name && <span className="ml-2 text-xs font-normal text-muted-foreground">{formatPhone(r.contact.phone)}</span>}
                </Link>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {r.sentAt && <span>{fmtDateTime(r.sentAt)}</span>}
                  {r.optedOutAt && <Badge tone="warning">saiu</Badge>}
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                {(r.errorMessage || r.skipReason) && <p className="w-full text-xs text-muted-foreground">{r.errorMessage ?? r.skipReason}</p>}
              </div>
            );
          })}
          {data && data.recipients.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Ninguém neste filtro.</p>}
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <span className="text-muted-foreground">
              {page} de {pages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Próxima
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TestDialog({ id, onDone }: { id: string; onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  async function send() {
    setSending(true);
    try {
      await api(`/campaigns/${id}/test`, { method: 'POST', body: { phone } });
      toast.success('Teste enviado');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Enviar teste</DialogTitle>
        <DialogDescription>Manda a mensagem para um número seu, do jeito que o cliente vai receber. Não entra no relatório.</DialogDescription>
      </DialogHeader>
      <Field label="Seu WhatsApp" htmlFor="test-phone">
        <Input id="test-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(11) 98888-7777" />
      </Field>
      <DialogFooter>
        <Button onClick={() => void send()} loading={sending} disabled={phone.trim().length < 8}>
          <Send /> Enviar teste
        </Button>
      </DialogFooter>
    </>
  );
}

/** Enviando: a cada 3 s. Encerrada há menos de 2 dias: a cada 15 s (recibos de entrega/leitura e respostas continuam chegando). */
function refreshFor(c: { status: string; finishedAt: string | null }): number {
  if (c.status === 'RUNNING' || c.status === 'SCHEDULED') return 3000;
  if (c.status === 'COMPLETED' && c.finishedAt && Date.now() - new Date(c.finishedAt).getTime() < 2 * 86_400_000) return 15_000;
  return 0;
}

export default function CampanhaPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error, mutate } = useSWR<CampaignDetail>(`/campaigns/${id}`, fetcher, {
    refreshInterval: (d) => (d ? refreshFor(d.campaign) : 0),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'test' | 'cancel' | null>(null);

  async function run(action: string, ok: string, fn = () => api(`/campaigns/${id}/${action}`, { method: 'POST' })) {
    setBusy(action);
    try {
      await fn();
      toast.success(ok);
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const { campaign: c, counts, number } = data;
  const editable = c.status === 'DRAFT' || c.status === 'SCHEDULED';
  const live = c.status === 'RUNNING' || c.status === 'SCHEDULED';

  return (
    <>
      <Link href="/campanhas" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Campanhas
      </Link>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight">{c.name}</h1>
            <CampaignStatusBadge status={c.status} waiting={Boolean(c.waitingReason)} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Template <b>{c.template.name}</b> · número <b>{c.phoneNumber.displayName}</b> · janela {c.windowStartHour}h às {c.windowEndHour}h
            {c.scheduledAt && ` · agendada para ${fmtDateTime(c.scheduledAt)}`}
            {c.startedAt && ` · início ${fmtDateTime(c.startedAt)}`}
            {c.finishedAt && ` · fim ${fmtDateTime(c.finishedAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.status === 'DRAFT' && (
            <Button onClick={() => void run('start', c.scheduledAt ? 'Campanha agendada' : 'Campanha iniciada')} loading={busy === 'start'}>
              <Rocket /> {c.scheduledAt ? 'Agendar' : 'Iniciar'}
            </Button>
          )}
          {c.status === 'RUNNING' && (
            <Button variant="outline" onClick={() => void run('pause', 'Campanha pausada')} loading={busy === 'pause'}>
              <Pause /> Pausar
            </Button>
          )}
          {c.status === 'PAUSED' && (
            <Button onClick={() => void run('resume', 'Campanha retomada')} loading={busy === 'resume'}>
              <Play /> Retomar
            </Button>
          )}
          {c.status === 'SCHEDULED' && (
            <Button variant="outline" onClick={() => void run('unschedule', 'Voltou para rascunho')} loading={busy === 'unschedule'}>
              <Undo2 /> Desagendar
            </Button>
          )}
          {editable && (
            <Button variant="outline" asChild>
              <Link href={`/campanhas/${id}/editar`}>
                <Pencil /> Editar
              </Link>
            </Button>
          )}
          <Button variant="outline" onClick={() => setDialog('test')}>
            <Send /> Teste
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void run('duplicate', 'Cópia criada', async () => {
                const r = await api<{ campaign: { id: string } }>(`/campaigns/${id}/duplicate`, { method: 'POST' });
                router.push(`/campanhas/${r.campaign.id}/editar`);
              })
            }
            loading={busy === 'duplicate'}
          >
            <Copy /> Duplicar
          </Button>
          {['SCHEDULED', 'RUNNING', 'PAUSED'].includes(c.status) && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              <Ban /> Cancelar
            </Button>
          )}
          {c.status === 'DRAFT' && (
            <Button
              variant="ghost"
              onClick={() =>
                void run('delete', 'Rascunho excluído', async () => {
                  await api(`/campaigns/${id}`, { method: 'DELETE' });
                  router.push('/campanhas');
                })
              }
              loading={busy === 'delete'}
            >
              <Trash2 /> Excluir
            </Button>
          )}
        </div>
      </div>

      {c.source === 'painel' && (c.status === 'DRAFT' || c.status === 'SCHEDULED') && (
        <Card className="mb-4 grid gap-3 border-primary/30 p-4 text-sm sm:grid-cols-[auto_1fr] sm:items-start">
          {c.headerMediaUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- arte enviada pelo painel
            <img src={c.headerMediaUrl} alt="Arte da campanha" className="max-h-56 w-auto rounded-lg border object-contain" />
          )}
          <div>
            <p className="font-semibold">Veio do painel do site: aguardando aprovação</p>
            <p className="mt-1 text-muted-foreground">Confira a arte, o texto e o público abaixo. Só um administrador inicia. Quem não deu opt-in ou pediu para sair fica de fora sozinho.</p>
          </div>
        </Card>
      )}

      {(c.status === 'PAUSED' && c.pausedReason) || (c.status === 'RUNNING' && c.waitingReason) || (live && number.blockReason) ? (
        <Card className="mb-4 flex gap-3 border-warning/40 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[oklch(0.6_0.13_60)]" />
          <div className="grid gap-1">
            {c.status === 'PAUSED' && c.pausedReason && (
              <p>
                <b>Pausada:</b> {c.pausedReason}
                {c.pausedAt ? ` (${fmtDateTime(c.pausedAt)})` : ''}.
              </p>
            )}
            {c.status === 'RUNNING' && c.waitingReason && <p>{c.waitingReason}</p>}
            {number.blockReason && <p>{number.blockReason}</p>}
          </div>
        </Card>
      ) : null}

      {counts.total > 0 ? (
        <div className="grid gap-4">
          <Card className="grid gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <b>{fmtInt(counts.total - counts.pending)}</b> de {fmtInt(counts.total)} processados
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <QualityBadge rating={number.qualityRating} /> {number.sendRatePerMinute}/min · até {fmtInt(number.dailyCap)} por dia
              </span>
            </div>
            <ProgressBar total={counts.total} sent={counts.sent} failed={counts.failed} skipped={counts.skipped} />
          </Card>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Enviados" value={counts.sent} />
            <Metric label="Entregues" value={counts.delivered} hint={pctOf(counts.delivered, counts.sent)} />
            <Metric label="Lidos" value={counts.read} hint={pctOf(counts.read, counts.delivered)} />
            <Metric label="Responderam" value={counts.replied} hint={pctOf(counts.replied, counts.delivered)} />
            <Metric label="Falhas" value={counts.failed} tone="danger" />
            <Metric label="Saíram (opt-out)" value={counts.optOuts} tone="danger" hint={pctOf(counts.optOuts, counts.delivered)} />
            <Metric label="Pulados" value={counts.skipped} tone="muted" />
            <Metric label="Na fila" value={counts.pending} tone="muted" />
          </div>
          {(data.skipReasons.length > 0 || data.failures.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              {data.skipReasons.length > 0 && (
                <Card className="p-4 text-sm">
                  <p className="mb-2 font-semibold">Por que ficaram de fora</p>
                  {data.skipReasons.map((r) => (
                    <p key={r.reason} className="flex justify-between gap-3 py-0.5 text-muted-foreground">
                      <span>{r.label}</span>
                      <b className="text-foreground">{fmtInt(r.count)}</b>
                    </p>
                  ))}
                </Card>
              )}
              {data.failures.length > 0 && (
                <Card className="p-4 text-sm">
                  <p className="mb-2 font-semibold">Motivos das falhas</p>
                  {data.failures.map((f) => (
                    <p key={f.message} className="flex justify-between gap-3 py-0.5 text-muted-foreground">
                      <span>{f.message}</span>
                      <b className="text-foreground">{fmtInt(f.count)}</b>
                    </p>
                  ))}
                </Card>
              )}
            </div>
          )}
          <Recipients id={id} refresh={refreshFor(c) && Math.max(refreshFor(c), 5000)} />
        </div>
      ) : (
        <Card className="p-6 text-sm text-muted-foreground">
          {c.status === 'DRAFT'
            ? 'Rascunho: o público é montado quando a campanha for iniciada (veja a estimativa em Editar).'
            : c.status === 'SCHEDULED'
              ? `Agendada. O público é montado e o envio começa em ${fmtDateTime(c.scheduledAt)}.`
              : 'Nenhum destinatário.'}
        </Card>
      )}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          {dialog === 'test' && <TestDialog id={id} onDone={() => setDialog(null)} />}
          {dialog === 'cancel' && (
            <>
              <DialogHeader>
                <DialogTitle>Cancelar campanha?</DialogTitle>
                <DialogDescription>
                  Quem ainda está na fila ({fmtInt(counts.pending)}) não vai receber. O que já foi enviado continua no relatório. Não dá para desfazer.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDialog(null)}>
                  Voltar
                </Button>
                <Button
                  variant="destructive"
                  loading={busy === 'cancel'}
                  onClick={() => void run('cancel', 'Campanha cancelada').then(() => setDialog(null))}
                >
                  Cancelar campanha
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
