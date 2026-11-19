'use client';

import { Download, Pencil, Play, Plus, RefreshCw, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { connectionLabel, QualityBadge, ROLE_LABEL } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { NumberRole, PhoneNumber } from '@/lib/types';
import { fmtInt, timeAgo } from '@/lib/utils';

type Modal = { kind: 'add' } | { kind: 'edit'; n: PhoneNumber } | { kind: 'test'; n: PhoneNumber } | null;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function NumberCard({ n, onChanged, onEdit, onTest }: { n: PhoneNumber; onChanged: () => void; onEdit: () => void; onTest: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const conn = connectionLabel(n.status);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className={n.isActive ? '' : 'opacity-60'}>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{n.displayName}</h3>
            <p className="text-sm text-muted-foreground">{n.displayPhone ?? 'telefone não informado'}</p>
          </div>
          <QualityBadge rating={n.qualityRating} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={conn.ok ? 'success' : 'warning'}>{conn.label}</Badge>
          <Badge tone="brand">{ROLE_LABEL[n.role]}</Badge>
          {n.campaignsPaused && <Badge tone="danger">Campanhas pausadas</Badge>}
          {!n.isActive && <Badge>Desativado</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/60 p-3 sm:grid-cols-3">
          <Stat label="Enviadas hoje" value={fmtInt(n.stats.sentToday)} />
          <Stat label="No mês" value={fmtInt(n.stats.sentMonth)} />
          <Stat label="Campanhas ativas" value={fmtInt(n.stats.activeCampaigns)} />
          <Stat label="Tier Meta" value={n.messagingTier?.replace('TIER_', '') ?? '—'} />
          <Stat label="Limite/dia" value={fmtInt(n.dailyConversationLimit)} />
          <Stat
            label="Ritmo"
            value={n.sendRatePerMinute === n.baseSendRatePerMinute ? `${n.sendRatePerMinute}/min` : `${n.sendRatePerMinute} de ${n.baseSendRatePerMinute}/min`}
          />
        </dl>
        <label className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span>
            Bot neste número
            {n.role === 'CAMPAIGNS' && <span className="block text-xs text-muted-foreground">Número só de campanhas: o bot não responde.</span>}
          </span>
          <Switch
            checked={n.botEnabled}
            disabled={busy !== null}
            onCheckedChange={(v) => run('bot', () => api(`/numbers/${n.id}`, { method: 'PATCH', body: { botEnabled: v } }), v ? 'Bot ligado' : 'Bot desligado')}
            aria-label={`Bot do número ${n.displayName}`}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          ID {n.phoneNumberId} · {n.hasOwnToken ? 'token próprio' : 'token padrão do .env'} · sincronizado {timeAgo(n.lastSyncedAt)}
        </p>
      </CardContent>
      <CardFooter className="flex-wrap">
        <Button size="sm" variant="outline" loading={busy === 'sync'} onClick={() => run('sync', () => api(`/numbers/${n.id}/sync`, { method: 'POST' }), 'Dados atualizados com a Meta')}>
          <RefreshCw /> Sincronizar
        </Button>
        <Button size="sm" variant="outline" onClick={onTest} disabled={!n.isActive}>
          <Send /> Testar envio
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil /> Editar
        </Button>
        {n.campaignsPaused && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'resume'}
            onClick={() => run('resume', () => api(`/numbers/${n.id}/resume-campaigns`, { method: 'POST' }), 'Campanhas liberadas para este número')}
          >
            <Play /> Retomar campanhas
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function AddDialog({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    try {
      await api('/numbers', {
        method: 'POST',
        body: {
          phoneNumberId: f.get('phoneNumberId'),
          wabaId: f.get('wabaId'),
          displayName: f.get('displayName') || undefined,
          accessToken: f.get('accessToken') || undefined,
          role: f.get('role'),
          baseSendRatePerMinute: Number(f.get('rate')) || undefined,
        },
      });
      toast.success('Número cadastrado e validado na Meta');
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Adicionar número</DialogTitle>
        <DialogDescription>Os dados estão em developers.facebook.com → seu app → WhatsApp → Configuração da API.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Phone number ID" htmlFor="phoneNumberId">
          <Input id="phoneNumberId" name="phoneNumberId" required inputMode="numeric" placeholder="ex.: 109876543210" />
        </Field>
        <Field label="WhatsApp Business Account ID (WABA)" htmlFor="wabaId">
          <Input id="wabaId" name="wabaId" required inputMode="numeric" />
        </Field>
        <Field label="Nome no painel" htmlFor="displayName" hint="Se ficar vazio, usamos o nome verificado na Meta.">
          <Input id="displayName" name="displayName" placeholder="ex.: Oliver — Atendimento" />
        </Field>
        <Field label="Função" htmlFor="role">
          <Select id="role" name="role" defaultValue="BOTH">
            {(Object.keys(ROLE_LABEL) as NumberRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Token permanente (opcional)" htmlFor="accessToken" hint="Deixe vazio para usar o META_ACCESS_TOKEN do .env. É guardado criptografado.">
          <Input id="accessToken" name="accessToken" type="password" autoComplete="off" />
        </Field>
        <Field label="Ritmo de campanha (mensagens/minuto)" htmlFor="rate" hint="Comece devagar: 20/min é conservador.">
          <Input id="rate" name="rate" type="number" min={1} max={120} defaultValue={20} />
        </Field>
        <DialogFooter>
          <Button type="submit" loading={loading}>
            Validar e salvar
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function EditDialog({ n, onDone }: { n: PhoneNumber; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(n.isActive);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const token = String(f.get('accessToken') ?? '');
    setLoading(true);
    try {
      await api(`/numbers/${n.id}`, {
        method: 'PATCH',
        body: {
          displayName: f.get('displayName'),
          role: f.get('role'),
          baseSendRatePerMinute: Number(f.get('rate')),
          isActive: active,
          ...(token ? { accessToken: token } : {}),
          ...(f.get('clearToken') ? { accessToken: null } : {}),
        },
      });
      toast.success('Número atualizado');
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Editar {n.displayName}</DialogTitle>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Nome no painel" htmlFor="displayName">
          <Input id="displayName" name="displayName" defaultValue={n.displayName} required />
        </Field>
        <Field label="Função" htmlFor="role">
          <Select id="role" name="role" defaultValue={n.role}>
            {(Object.keys(ROLE_LABEL) as NumberRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Ritmo de campanha (mensagens/minuto)"
          htmlFor="rate"
          hint="Se a qualidade cair, o sistema reduz automaticamente a partir deste valor."
        >
          <Input id="rate" name="rate" type="number" min={1} max={120} defaultValue={n.baseSendRatePerMinute} />
        </Field>
        <Field label="Novo token (opcional)" htmlFor="accessToken" hint={n.hasOwnToken ? 'Este número já tem token próprio.' : 'Hoje usa o token padrão do .env.'}>
          <Input id="accessToken" name="accessToken" type="password" autoComplete="off" />
        </Field>
        {n.hasOwnToken && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="clearToken" className="size-4 accent-[var(--primary)]" /> Remover token próprio e usar o do .env
          </label>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Número ativo</span>
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
        <DialogFooter>
          <Button type="submit" loading={loading}>
            Salvar
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function TestDialog({ n, onDone }: { n: PhoneNumber; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const to = new FormData(e.currentTarget).get('to');
    setLoading(true);
    try {
      const r = await api<{ mode: 'text' | 'template'; template?: string }>(`/numbers/${n.id}/test`, { method: 'POST', body: { to } });
      toast.success(
        r.mode === 'text' ? 'Mensagem de teste enviada' : `Enviado o template "${r.template}" (a janela de 24h com esse telefone está fechada)`,
      );
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Testar envio</DialogTitle>
        <DialogDescription>
          Envia pelo número <strong>{n.displayName}</strong>. Se esse telefone não escreveu para a empresa nas últimas 24h, a Meta só permite
          template, então enviamos o template de teste.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Seu WhatsApp" htmlFor="to">
          <Input id="to" name="to" required inputMode="tel" placeholder="(11) 98888-7777" autoComplete="tel" />
        </Field>
        <DialogFooter>
          <Button type="submit" loading={loading}>
            <Send /> Enviar teste
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export default function NumerosPage() {
  const { data, error, mutate } = useSWR<{ numbers: PhoneNumber[] }>('/numbers', fetcher);
  const [modal, setModal] = useState<Modal>(null);
  const [importing, setImporting] = useState(false);

  async function importWaba() {
    setImporting(true);
    try {
      const r = await api<{ found: number; created: string[] }>('/numbers/import', { method: 'POST' });
      toast.success(r.created.length ? `Importados: ${r.created.join(', ')}` : `Nenhum número novo (${r.found} encontrados na WABA)`);
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  const close = () => setModal(null);
  const done = () => {
    close();
    void mutate();
  };

  return (
    <>
      <PageHeader
        title="Números"
        description="Números da WABA, qualidade, limite de conversas e ritmo de envio. Se a qualidade cair para média o ritmo é reduzido; se cair para baixa, as campanhas do número são pausadas."
        actions={
          <>
            <Button variant="outline" onClick={importWaba} loading={importing}>
              <Download /> Importar da WABA
            </Button>
            <Button onClick={() => setModal({ kind: 'add' })}>
              <Plus /> Adicionar número
            </Button>
          </>
        }
      />

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data?.numbers.length === 0 && (
        <Card className="grid place-items-center gap-3 border-dashed p-10 text-center">
          <p className="font-semibold">Nenhum número ainda</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Importe os números da sua WABA (usa o META_WABA_ID do .env) ou adicione manualmente pelo phone_number_id.
          </p>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {data?.numbers.map((n) => (
          <NumberCard
            key={n.id}
            n={n}
            onChanged={() => void mutate()}
            onEdit={() => setModal({ kind: 'edit', n })}
            onTest={() => setModal({ kind: 'test', n })}
          />
        ))}
      </div>

      <Dialog open={modal !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          {modal?.kind === 'add' && <AddDialog onDone={done} />}
          {modal?.kind === 'edit' && <EditDialog n={modal.n} onDone={done} />}
          {modal?.kind === 'test' && <TestDialog n={modal.n} onDone={done} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
