'use client';

import { KeyRound, Plus, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { ROLE_LABEL } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Label, Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { BotSettings, BusinessHours, DayKey } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

const DAYS: { key: DayKey; label: string }[] = [
  { key: '1', label: 'Segunda' },
  { key: '2', label: 'Terça' },
  { key: '3', label: 'Quarta' },
  { key: '4', label: 'Quinta' },
  { key: '5', label: 'Sexta' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
];

function HoursEditor({ initial, onSaved }: { initial: BusinessHours; onSaved: () => void }) {
  const [hours, setHours] = useState<BusinessHours>(initial);
  const [holiday, setHoliday] = useState('');
  const [saving, setSaving] = useState(false);

  const setDay = (k: DayKey, v: [string, string] | undefined) => setHours((h) => ({ ...h, days: { ...h.days, [k]: v } }));

  async function save() {
    const days = Object.fromEntries(Object.entries(hours.days).filter(([, v]) => v));
    setSaving(true);
    try {
      await api('/bot/settings', { method: 'PUT', body: { businessHours: { ...hours, days } } });
      toast.success('Horário salvo');
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        {DAYS.map(({ key, label }) => {
          const range = hours.days[key];
          return (
            <div key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b pb-2 last:border-0 sm:grid-cols-[100px_auto_1fr] sm:border-0 sm:pb-0">
              <Label htmlFor={`d${key}`}>{label}</Label>
              <Switch id={`d${key}`} checked={Boolean(range)} onCheckedChange={(v) => setDay(key, v ? ['09:00', '18:00'] : undefined)} />
              {range ? (
                <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                  <Input type="time" value={range[0]} onChange={(e) => setDay(key, [e.target.value, range[1]])} className="h-9 w-28" aria-label={`${label}: abre`} />
                  <span className="text-xs text-muted-foreground">até</span>
                  <Input type="time" value={range[1]} onChange={(e) => setDay(key, [range[0], e.target.value])} className="h-9 w-28" aria-label={`${label}: fecha`} />
                </div>
              ) : (
                <span className="col-span-2 text-sm text-muted-foreground sm:col-span-1">fechado</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="grid gap-2 border-t pt-3">
        <Label>Feriados e dias fechados</Label>
        <div className="flex flex-wrap gap-1.5">
          {hours.closedDates.length === 0 && <span className="text-xs text-muted-foreground">Nenhum.</span>}
          {hours.closedDates.map((d) => (
            <Badge key={d} tone="neutral" className="gap-1">
              {fmtDate(d)}
              <button
                onClick={() => setHours((h) => ({ ...h, closedDates: h.closedDates.filter((x) => x !== d) }))}
                className="cursor-pointer"
                aria-label={`Remover ${fmtDate(d)}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} className="h-9 w-44" aria-label="Data fechada" />
          <Button
            size="sm"
            variant="outline"
            disabled={!holiday}
            onClick={() => {
              setHours((h) => ({ ...h, closedDates: [...new Set([...h.closedDates, holiday])].sort() }));
              setHoliday('');
            }}
          >
            <Plus /> Adicionar
          </Button>
        </div>
      </div>
      <Button className="justify-self-start" onClick={() => void save()} loading={saving}>
        Salvar horário
      </Button>
    </div>
  );
}

export function BotSettingsPanel() {
  const { data, mutate } = useSWR<BotSettings>('/bot/settings', fetcher);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
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

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="grid content-start gap-4">
        {data.mode !== 'ai' && (
          <Card className="flex gap-3 border-warning/40 p-4 text-sm">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[oklch(0.6_0.13_60)]" />
            <p>
              No <code>.env</code> está <code>BOT_MODE={data.mode}</code>: no WhatsApp o bot de IA ainda não responde
              {data.mode === 'echo' ? ' (vai a resposta de teste)' : ''}. Troque para <code>BOT_MODE=ai</code> e reinicie a API. O simulador funciona de qualquer jeito.
            </p>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Liga/desliga</CardTitle>
            <CardDescription>Desligado, as mensagens chegam na Inbox e esperam um atendente.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <Label htmlFor="global">Bot em todos os números</Label>
              <Switch
                id="global"
                checked={data.enabled}
                disabled={busy === 'global'}
                onCheckedChange={(v) => void run('global', () => api('/settings/bot', { method: 'PUT', body: { enabled: v } }), v ? 'Bot ligado' : 'Bot desligado')}
              />
            </div>
            {data.numbers.map((n) => (
              <div key={n.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <Label htmlFor={`n${n.id}`} className="block truncate">
                    {n.displayName}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {n.displayPhone ?? ''} · {ROLE_LABEL[n.role]}
                    {n.role === 'CAMPAIGNS' ? ' (o bot não atende números só de campanha)' : ''}
                  </span>
                </div>
                <Switch
                  id={`n${n.id}`}
                  checked={n.botEnabled}
                  disabled={!data.enabled || n.role === 'CAMPAIGNS' || busy === n.id}
                  onCheckedChange={(v) => void run(n.id, () => api(`/numbers/${n.id}`, { method: 'PATCH', body: { botEnabled: v } }), v ? 'Bot ligado neste número' : 'Bot desligado neste número')}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Chave da Anthropic
            </CardTitle>
            <CardDescription>
              Modelo <code>{data.model}</code>, esforço <code>{data.effort}</code> (definidos no .env).{' '}
              {data.apiKey.configured
                ? `Chave em uso: termina em …${data.apiKey.last4} (${data.apiKey.source === 'painel' ? 'salva aqui, criptografada' : 'do arquivo .env'}).`
                : 'Nenhuma chave configurada: o bot passa as conversas para a equipe.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void run('key', () => api('/bot/settings', { method: 'PUT', body: { anthropicApiKey: key } }), 'Chave salva').then(() => setKey(''));
              }}
            >
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" aria-label="Nova chave da Anthropic" />
              <div className="flex shrink-0 gap-2">
                <Button type="submit" disabled={!key} loading={busy === 'key'}>
                  Salvar
                </Button>
                {data.apiKey.source === 'painel' && (
                  <Button type="button" variant="ghost" onClick={() => void run('key', () => api('/bot/settings', { method: 'PUT', body: { anthropicApiKey: null } }), 'Chave removida')}>
                    Remover
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Transferir depois de quantas tentativas?</CardTitle>
            <CardDescription>Buscas ou consultas seguidas que não acharam nada. 0 desliga esta regra (as outras transferências continuam).</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(new FormData(e.currentTarget).get('max'));
                void run('max', () => api('/bot/settings', { method: 'PUT', body: { maxFailedAttempts: n } }), 'Salvo');
              }}
            >
              <Field label="Tentativas" htmlFor="max">
                <Input id="max" name="max" type="number" min={0} max={10} defaultValue={data.maxFailedAttempts} className="w-24" />
              </Field>
              <Button type="submit" variant="outline" loading={busy === 'max'}>
                Salvar
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card className="content-start">
        <CardHeader>
          <CardTitle>Horário de atendimento humano</CardTitle>
          <CardDescription>
            Agora: {data.humanOpenNow ? 'aberto' : `fechado${data.nextOpening ? `, volta ${data.nextOpening}` : ''}`}. Fora do horário o bot continua
            atendendo sobre produtos e avisa quando a equipe volta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HoursEditor key={JSON.stringify(data.businessHours)} initial={data.businessHours} onSaved={() => void mutate()} />
        </CardContent>
      </Card>
    </div>
  );
}
