'use client';

import { FileText, Heart, MessageCircle, RefreshCw, Save, Send, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { formatPhone } from '@/components/contact-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import { cn, fmtDateTime, timeAgo } from '@/lib/utils';

type Kind = 'AVALIACAO' | 'ANIVERSARIO' | 'RECOMPRA' | 'CARRINHO';
interface Row {
  key: string;
  kind: Kind;
  contactId: string;
  name: string;
  phone: string;
  detail: string;
  variables: string[];
  preview: string;
  alreadySent: boolean;
  blocked: string | null;
}
interface Config {
  reviewLink: string;
  birthdayGift: string;
  restockDays: number;
  restockLink: string;
  phoneNumberId: string | null;
  templates: Record<Kind, string>;
}
interface Data {
  today: string;
  avaliacao: Row[];
  aniversario: Row[];
  recompra: Row[];
  carrinho: Row[];
  stats: { optInTotal: number; withBirth: number; withLastOrder: number };
  config: Config;
  sync: { lastSyncAt: string | null; checked: number; pending: number; lastError: string | null };
  numbers: { id: string; displayName: string; displayPhone: string | null }[];
  kinds: { key: Kind; label: string; when: string; vars: string[]; suggested: { body: string }; template: { name: string; status: string; rejectedReason: string | null } | null }[];
}

const TABS = [
  { key: 'avaliacao', label: 'Avaliação', empty: 'Nenhum pedido atendido há 2 dias de cliente com opt-in.' },
  { key: 'aniversario', label: 'Aniversário', empty: 'Ninguém com opt-in faz aniversário hoje.' },
  { key: 'recompra', label: 'Hora de repor', empty: 'Ninguém com opt-in completou o prazo desde a última compra.' },
  { key: 'carrinho', label: 'Carrinho parado', empty: 'Nenhum carrinho parado de cliente com opt-in (o site informa em Integração com o site).' },
  { key: 'historico', label: 'Histórico', empty: '' },
  { key: 'config', label: 'Configurações', empty: '' },
] as const;
type Tab = (typeof TABS)[number]['key'];
const KIND_LABEL: Record<Kind, string> = { AVALIACAO: 'avaliação', ANIVERSARIO: 'aniversário', RECOMPRA: 'hora de repor', CARRINHO: 'carrinho parado' };

function ConfigTab({ data, refresh }: { data: Data; refresh: () => void }) {
  const [draft, setDraft] = useState<Config | null>(null);
  const cfg = draft ?? data.config;
  const [busy, setBusy] = useState<'save' | 'tpl' | null>(null);
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setDraft({ ...cfg, [k]: v });
  const missing = data.kinds.filter((k) => !k.template).length;
  async function run(kind: 'save' | 'tpl') {
    setBusy(kind);
    try {
      if (kind === 'save') {
        await api('/relation/config', { method: 'PUT', body: cfg });
        toast.success('Configurações salvas');
        setDraft(null);
      } else {
        const r = await api<{ results: { name: string; error?: string }[] }>('/relation/templates', { method: 'POST' });
        const errs = r.results.filter((x) => x.error);
        if (errs.length) toast.error(errs.map((x) => `${x.name}: ${x.error}`).join('\n'));
        else toast.success('Templates enviados para a Meta aprovar (categoria Marketing, com botão "Parar promoções").');
      }
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <CardContent className="grid gap-5 pt-4 lg:grid-cols-2">
      <div className="grid content-start gap-3">
        <Field label="Link de avaliação" htmlFor="rv" hint="Ex.: link de avaliação do Google ou a página de avaliações do site.">
          <Input id="rv" value={cfg.reviewLink} onChange={(e) => set('reviewLink', e.target.value)} placeholder="https://..." />
        </Field>
        <Field label="Presente de aniversário" htmlFor="gift" hint='Completa a frase "preparou um presente pra você: ...".'>
          <Input id="gift" value={cfg.birthdayGift} onChange={(e) => set('birthdayGift', e.target.value)} placeholder="10% de desconto com o cupom NIVER10 até o fim do mês" />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label="Hora de repor: dias depois da compra" htmlFor="days">
            <Input id="days" type="number" min={7} max={365} value={cfg.restockDays} onChange={(e) => set('restockDays', Number(e.target.value) || 45)} className="w-28" />
          </Field>
        </div>
        <Field label="Link da loja (hora de repor)" htmlFor="rl">
          <Input id="rl" value={cfg.restockLink} onChange={(e) => set('restockLink', e.target.value)} placeholder="https://..." />
        </Field>
        <Field label="Número que envia" htmlFor="num">
          <Select id="num" value={cfg.phoneNumberId ?? ''} onChange={(e) => set('phoneNumberId', e.target.value || null)}>
            <option value="">Primeiro número de atendimento</option>
            {data.numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName} {n.displayPhone ? `(${n.displayPhone})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => void run('save')} loading={busy === 'save'} disabled={!draft} className="justify-self-start">
          <Save /> Salvar
        </Button>
      </div>
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium">Templates</p>
        {missing > 0 && (
          <Button size="sm" variant="outline" onClick={() => void run('tpl')} loading={busy === 'tpl'} className="justify-self-start">
            <FileText /> Criar templates sugeridos ({missing})
          </Button>
        )}
        {data.kinds.map((k) => (
          <div key={k.key} className="grid gap-1 rounded-lg border p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <b className="font-medium">{k.label}</b>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{cfg.templates[k.key]}</code>
              {k.template ? <Badge tone={k.template.status === 'APPROVED' ? 'success' : k.template.status === 'REJECTED' ? 'danger' : 'warning'}>{k.template.status === 'APPROVED' ? 'aprovado' : k.template.status === 'REJECTED' ? 'recusado' : 'em análise'}</Badge> : <Badge tone="danger">não existe</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">{k.when}</p>
            <p className="text-xs">{k.suggested.body}</p>
          </div>
        ))}
      </div>
    </CardContent>
  );
}

function History() {
  const { data } = useSWR<{ history: { id: string; kind: Kind; status: 'SENT' | 'FAILED'; contactName: string | null; reason: string | null; sentBy: string | null; conversationId: string | null; createdAt: string }[] }>('/relation/history', fetcher);
  return (
    <CardContent className="grid gap-3 pt-4">
      {data?.history.length === 0 && <p className="py-4 text-sm text-muted-foreground">Nenhuma mensagem enviada ainda.</p>}
      <div className="divide-y rounded-lg border empty:hidden">
        {data?.history.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span>
              <b className="font-medium">{h.contactName}</b> · {KIND_LABEL[h.kind]}
              {h.reason && <span className="block text-xs text-destructive">{h.reason}</span>}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge tone={h.status === 'SENT' ? 'success' : 'danger'}>{h.status === 'SENT' ? 'Enviado' : 'Falhou'}</Badge>
              <span title={fmtDateTime(h.createdAt)}>
                {timeAgo(h.createdAt)}
                {h.sentBy ? ` por ${h.sentBy}` : ''}
              </span>
              {h.conversationId && (
                <Link href={`/inbox?c=${h.conversationId}`} className="font-medium text-primary hover:underline">
                  conversa
                </Link>
              )}
            </span>
          </div>
        ))}
      </div>
    </CardContent>
  );
}

export default function RelacionamentoPage() {
  const { data, error, mutate } = useSWR<Data>('/relation', fetcher);
  const [tab, setTab] = useState<Tab>('avaliacao');
  const [sending, setSending] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmMany, setConfirmMany] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'one' | 'many' | null>(null);

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const rows: Row[] = tab === 'avaliacao' || tab === 'aniversario' || tab === 'recompra' || tab === 'carrinho' ? data[tab] : [];
  const chosen = rows.filter((r) => selected.has(r.key));

  async function sync() {
    setBusy('sync');
    try {
      const r = await api<{ checked: number; pending: number }>('/relation/sync', { method: 'POST' });
      toast.success(`${r.checked} contato(s) lido(s) no Bling${r.pending ? ` · faltam ${r.pending} (continua sozinho a cada 6 h)` : ''}`);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function sendOne() {
    if (!sending) return;
    setBusy('one');
    try {
      const r = await api<{ status: string; reason?: string }>('/relation/send', { method: 'POST', body: { key: sending.key } });
      if (r.status === 'SENT') toast.success(`Enviado para ${sending.name}`);
      else toast.error(`Não foi: ${r.reason}`);
      setSending(null);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function sendMany() {
    setBusy('many');
    try {
      const r = await api<{ sent: number; results: { status: string; reason?: string }[] }>('/relation/send-many', { method: 'POST', body: { keys: chosen.map((c) => c.key) } });
      toast.success(`${r.sent} mensagem(ns) enviada(s)`);
      const fails = r.results.filter((x) => x.status !== 'SENT');
      if (fails.length) toast.error(`${fails.length} não foram: ${fails[0]?.reason ?? ''}`);
      setSelected(new Set());
      setConfirmMany(false);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Relacionamento"
        description="Avaliação, aniversário e hora de repor. Só para quem deu opt-in e nunca pediu para sair. Cada mensagem é um clique (ou selecione várias)."
        actions={
          <Button variant="outline" onClick={sync} loading={busy === 'sync'}>
            <RefreshCw /> Ler aniversários e compras do Bling
          </Button>
        }
      />
      <p className="mb-3 text-xs text-muted-foreground">
        {data.stats.optInTotal} contato(s) com opt-in · {data.stats.withBirth} com aniversário no Bling · {data.stats.withLastOrder} com compra no Bling.{' '}
        {data.sync.lastSyncAt ? `Lido ${timeAgo(data.sync.lastSyncAt)}.` : 'Ainda não lido.'}
        {data.sync.lastError && <span className="text-destructive"> {data.sync.lastError}</span>}
        {data.stats.optInTotal > 0 && data.stats.withBirth === 0 && ' Dica: o aniversário vem do campo "Data de nascimento" do cadastro no Bling.'}
      </p>
      <Card>
        <div className="-mb-px flex gap-1 overflow-x-auto border-b px-2 pt-2 [scrollbar-width:none]">
          {TABS.map((t) => {
            const list = t.key === 'avaliacao' || t.key === 'aniversario' || t.key === 'recompra' || t.key === 'carrinho' ? data[t.key] : null;
            const n = list ? list.filter((r) => !r.alreadySent).length : 0;
            return (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key);
                  setSelected(new Set());
                }}
                className={cn(
                  'flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium',
                  tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.key === 'config' && <Settings2 className="size-4" />}
                {t.label}
                {n > 0 && <span className="rounded-full bg-secondary px-1.5 text-[11px] font-semibold text-secondary-foreground">{n}</span>}
              </button>
            );
          })}
        </div>
        {tab === 'historico' && <History />}
        {tab === 'config' && <ConfigTab data={data} refresh={() => void mutate()} />}
        {rows.length === 0 && tab !== 'historico' && tab !== 'config' && <CardContent className="py-10 text-center text-sm text-muted-foreground">{TABS.find((t) => t.key === tab)?.empty}</CardContent>}
        {rows.length > 0 && (
          <>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 py-3">
              <CardDescription>{rows.length} cliente(s)</CardDescription>
              {chosen.length > 0 && (
                <Button size="sm" onClick={() => setConfirmMany(true)}>
                  <Send /> Enviar para {chosen.length} selecionada(s)
                </Button>
              )}
            </CardHeader>
            <div className="divide-y border-t">
              {rows.map((r) => (
                <div key={r.key} className={cn('grid gap-2 px-4 py-3 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4', r.alreadySent && 'bg-muted/40')}>
                  <input
                    type="checkbox"
                    className="hidden size-4 accent-[var(--primary)] sm:block"
                    checked={selected.has(r.key)}
                    disabled={Boolean(r.blocked) || r.alreadySent}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      setSelected(next);
                    }}
                    aria-label={`Selecionar ${r.name}`}
                  />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {r.name} {r.alreadySent && <Badge tone="success">enviado</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatPhone(r.phone)} · {r.detail}
                    </p>
                    {r.blocked && <p className="text-xs text-destructive">{r.blocked}</p>}
                  </div>
                  <Button size="sm" onClick={() => setSending(r)} disabled={Boolean(r.blocked) || r.alreadySent} className="justify-self-start sm:justify-self-end">
                    <MessageCircle /> {r.alreadySent ? 'Enviado' : 'Enviar'}
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Dialog open={Boolean(sending)} onOpenChange={(o) => !o && setSending(null)}>
        <DialogContent>
          {sending && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Heart className="size-4" /> Enviar para {sending.name}?
                </DialogTitle>
                <DialogDescription>Pelo WhatsApp oficial, para {formatPhone(sending.phone)}. A mensagem tem o botão “Parar promoções”.</DialogDescription>
              </DialogHeader>
              <p className="whitespace-pre-wrap rounded-xl rounded-tr-sm bg-[oklch(0.93_0.04_335)] p-3 text-[14.5px] leading-relaxed">{sending.preview}</p>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSending(null)}>
                  Cancelar
                </Button>
                <Button onClick={sendOne} loading={busy === 'one'}>
                  <Send /> Enviar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmMany} onOpenChange={setConfirmMany}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar {chosen.length} mensagem(ns)?</DialogTitle>
            <DialogDescription>Cada cliente recebe a sua mensagem com o próprio nome. Não dá para desfazer.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border text-sm">
            {chosen.map((c) => (
              <li key={c.key} className="px-3 py-2">
                {c.name}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmMany(false)}>
              Cancelar
            </Button>
            <Button onClick={sendMany} loading={busy === 'many'}>
              <Send /> Enviar {chosen.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
