'use client';

import { AlertTriangle, CheckCheck, Info, OctagonAlert } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { QualityBadge, ROLE_LABEL } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { Alert, Dashboard } from '@/lib/types';
import { fmtInt, timeAgo } from '@/lib/utils';

const ALERT_ICON = { INFO: Info, WARNING: AlertTriangle, CRITICAL: OctagonAlert };
const ALERT_STYLE = {
  INFO: 'bg-muted',
  WARNING: 'bg-warning-soft',
  CRITICAL: 'bg-danger-soft',
};

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export default function VisaoGeral() {
  const { data, error, mutate } = useSWR<Dashboard>('/dashboard', fetcher, { refreshInterval: 30_000 });

  async function toggleBot(enabled: boolean) {
    try {
      await api('/settings/bot', { method: 'PUT', body: { enabled } });
      await mutate();
      toast.success(enabled ? 'Bot ligado em todos os números' : 'Bot desligado: as mensagens só serão registradas');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function readAlert(a?: Alert) {
    await api(a ? `/alerts/${a.id}/read` : '/alerts/read-all', { method: 'POST' }).catch((e: Error) => toast.error(e.message));
    await mutate();
  }

  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  const approved = data.totals.templates.APPROVED ?? 0;
  const sentToday = data.numbers.reduce((s, n) => s + n.stats.sentToday, 0);

  return (
    <>
      <PageHeader title="Visão geral" description="Saúde dos números, alertas e o que está acontecendo agora." />

      {data.alerts.length > 0 && (
        <section className="mb-6 grid gap-2" aria-label="Alertas">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Alertas ({data.alerts.length})</h2>
            <Button variant="ghost" size="sm" onClick={() => readAlert()}>
              <CheckCheck /> Marcar todos como lidos
            </Button>
          </div>
          {data.alerts.map((a) => {
            const Icon = ALERT_ICON[a.level];
            return (
              <div key={a.id} className={`flex items-start gap-3 rounded-lg px-4 py-3 ${ALERT_STYLE[a.level]}`}>
                <Icon className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{a.message}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{timeAgo(a.createdAt)}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => readAlert(a)}>
                  Ok
                </Button>
              </div>
            );
          })}
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Enviadas hoje" value={fmtInt(sentToday)} hint="todos os números" />
        <Kpi label="Aguardando resposta" value={fmtInt(data.totals.awaitingReply)} hint="cliente falou por último" />
        <Kpi label="Contatos" value={fmtInt(data.totals.contacts)} hint={`${fmtInt(data.totals.optOuts)} ${data.totals.optOuts === 1 ? 'pediu' : 'pediram'} para sair`} />
        <Kpi label="Templates aprovados" value={fmtInt(approved)} hint={`${fmtInt(data.totals.templates.PENDING ?? 0)} em análise`} />
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Números</CardTitle>
              <CardDescription>Qualidade e envios de hoje</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/numeros">Gerenciar</Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-2">
            {data.numbers.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Nenhum número cadastrado. <Link href="/numeros" className="font-semibold text-primary">Adicionar o primeiro</Link>
              </p>
            )}
            {data.numbers.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{n.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {n.displayPhone ?? n.phoneNumberId} · {ROLE_LABEL[n.role]}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs tabular-nums text-muted-foreground">{fmtInt(n.stats.sentToday)} hoje</span>
                  <QualityBadge rating={n.qualityRating} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bot de atendimento</CardTitle>
            <CardDescription>Chave geral. Cada número também tem a sua.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-3">
              <span className="text-sm font-medium">{data.bot.enabled ? 'Ligado' : 'Desligado'}</span>
              <Switch checked={data.bot.enabled} onCheckedChange={toggleBot} aria-label="Ligar ou desligar o bot" />
            </label>
            <p className="text-xs text-muted-foreground">
              Modo atual: <strong>{data.bot.mode === 'ai' ? 'IA (Claude)' : data.bot.mode === 'echo' ? 'resposta de teste' : 'só registrar'}</strong>.
              O bot de IA chega na etapa 5.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
