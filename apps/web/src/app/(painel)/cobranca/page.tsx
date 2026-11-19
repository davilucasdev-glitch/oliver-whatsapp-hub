'use client';

import { AlertTriangle, FileText, MessageCircle, RefreshCw, Save, Send, Settings2 } from 'lucide-react';
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
import { cn, fmtDateTime, fmtMoney, timeAgo } from '@/lib/utils';

type Kind = 'LEMBRETE' | 'VENCE_HOJE' | 'ATRASO' | 'PAGAMENTO';

interface Row {
  key: string;
  kind: Kind;
  contactBlingId: string;
  name: string;
  phone: string | null;
  phoneSource: string | null;
  receivables: { id: string; valor: number; remaining: number; remainingKnown: boolean; vencimento: string; orderNumber: string | null }[];
  amount: number;
  balance: number;
  balanceKnown: boolean;
  dueDate: string | null;
  daysLate: number | null;
  variables: string[];
  preview: string;
  alreadySent: boolean;
  lastCharge: { kind: Kind; at: string; by: string | null } | null;
  blocked: string | null;
}

interface Config {
  pixKey: string;
  cutoff: string;
  reminderDays: number;
  ownerUserId: string | null;
  phoneNumberId: string | null;
  templates: Record<Kind, string>;
}

interface Data {
  today: string;
  lembrete: Row[];
  hoje: Row[];
  atraso: Row[];
  pagos: Row[];
  config: Config;
  sync: { lastSyncAt: string | null; lastError: string | null; open: number; unknownRemaining: number };
  blingConnected: boolean;
  kinds: { key: Kind; label: string; when: string; vars: string[]; suggested: { name: string; body: string }; template: { name: string; status: string; rejectedReason: string | null } | null }[];
  users: { id: string; name: string }[];
  numbers: { id: string; displayName: string; displayPhone: string | null }[];
}

const TABS = [
  { key: 'lembrete', label: 'Vence em breve', empty: 'Nenhuma parcela vence daqui a 2 dias.' },
  { key: 'hoje', label: 'Vence hoje', empty: 'Nenhuma parcela vence hoje.' },
  { key: 'atraso', label: 'Em atraso', empty: 'Ninguém em atraso. 🎉' },
  { key: 'pagos', label: 'Pagamentos recebidos', empty: 'Nenhuma baixa no Bling nos últimos 7 dias.' },
  { key: 'historico', label: 'Histórico', empty: '' },
  { key: 'config', label: 'Configurações', empty: '' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const KIND_LABEL: Record<Kind, string> = { LEMBRETE: 'lembrete', VENCE_HOJE: 'vence hoje', ATRASO: 'em aberto', PAGAMENTO: 'pagamento recebido' };
const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const parseMoney = (s: string) => Number(s.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));

function SendDialog({ row, onClose, onSent }: { row: Row | null; onClose: () => void; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState('');
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (row && row.key !== lastKey) {
    setLastKey(row.key);
    setBalance(row.balanceKnown ? '' : String(row.balance).replace('.', ','));
  }
  const needsBalance = row && !row.balanceKnown && (row.kind === 'ATRASO' || row.kind === 'PAGAMENTO');
  const typed = parseMoney(balance);
  const preview = row && needsBalance && Number.isFinite(typed) && balance ? row.preview.replace(fmtMoney(row.balance).replace(/\s/g, ' '), fmtMoney(typed).replace(/\s/g, ' ')) : row?.preview;

  async function send() {
    if (!row) return;
    if (needsBalance && !(Number.isFinite(typed) && typed >= 0 && balance)) return toast.error('Informe o saldo do crediário.');
    setBusy(true);
    try {
      const r = await api<{ status: string; reason?: string }>('/charges/send', { method: 'POST', body: { key: row.key, ...(needsBalance ? { balance: typed } : {}) } });
      if (r.status === 'SENT') toast.success(`Enviado para ${row.name}`);
      else toast.error(`Não foi: ${r.reason}`);
      onSent();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(row)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {row && (
          <>
            <DialogHeader>
              <DialogTitle>Enviar para {row.name}?</DialogTitle>
              <DialogDescription>
                Pelo WhatsApp oficial, para {row.phone ? formatPhone(row.phone) : '—'}
                {row.phoneSource === 'pedido' ? ' (WhatsApp do pedido do site)' : row.phoneSource === 'contato' ? ' (cadastro do Bling)' : ''}.
              </DialogDescription>
            </DialogHeader>
            {needsBalance && (
              <div className="grid gap-2 rounded-lg bg-warning-soft p-3 text-sm">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  Esta cliente tem parcela paga em parte, e o Bling não informou quanto falta. Confira o saldo no crediário e digite aqui.
                </p>
                <Field label="Saldo total no crediário" htmlFor="bal">
                  <Input id="bal" value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" className="w-40" autoFocus />
                </Field>
              </div>
            )}
            <p className="whitespace-pre-wrap rounded-xl rounded-tr-sm bg-[oklch(0.93_0.04_335)] p-3 text-[14.5px] leading-relaxed">{preview}</p>
            {row.lastCharge && (
              <p className="text-xs text-muted-foreground">
                Última cobrança: {KIND_LABEL[row.lastCharge.kind]} {timeAgo(row.lastCharge.at)}
                {row.lastCharge.by ? `, por ${row.lastCharge.by}` : ''}.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={send} loading={busy}>
                <Send /> Enviar
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RowItem({ row, selected, onToggle, onSend }: { row: Row; selected: boolean; onToggle: () => void; onSend: () => void }) {
  const canBulk = !row.blocked && !row.alreadySent && (row.balanceKnown || row.kind === 'LEMBRETE' || row.kind === 'VENCE_HOJE');
  const orders = [...new Set(row.receivables.map((r) => r.orderNumber).filter(Boolean))];
  return (
    <div className={cn('grid gap-2 px-4 py-3 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4', row.alreadySent && 'bg-muted/40')}>
      <input type="checkbox" className="hidden size-4 accent-[var(--primary)] sm:block" checked={selected} onChange={onToggle} disabled={!canBulk} aria-label={`Selecionar ${row.name}`} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {row.name}
          {row.alreadySent && <Badge tone="success">enviado</Badge>}
          {row.kind === 'ATRASO' && row.daysLate !== null && <Badge tone={row.daysLate > 15 ? 'danger' : 'warning'}>{row.daysLate === 1 ? '1 dia' : `${row.daysLate} dias`}</Badge>}
        </p>
        <p className="text-sm">
          <b>{fmtMoney(row.amount)}</b>
          {row.kind === 'PAGAMENTO' ? ' pago' : row.dueDate ? ` · vence ${ddmm(row.dueDate)}` : ' em atraso'}
          <span className="text-muted-foreground">
            {' '}
            · saldo {row.balanceKnown ? fmtMoney(row.balance) : `≈ ${fmtMoney(row.balance)} (confira)`}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {row.phone ? formatPhone(row.phone) : 'sem telefone'}
          {orders.length ? ` · pedido${orders.length > 1 ? 's' : ''} ${orders.join(', ')}` : ''}
          {row.lastCharge ? ` · cobrado ${timeAgo(row.lastCharge.at)}${row.lastCharge.by ? ` por ${row.lastCharge.by}` : ''}` : ''}
        </p>
        {row.blocked && <p className="mt-0.5 text-xs text-destructive">{row.blocked}</p>}
      </div>
      <Button size="sm" variant={row.alreadySent ? 'outline' : 'default'} onClick={onSend} disabled={Boolean(row.blocked) || row.alreadySent} className="justify-self-start sm:justify-self-end">
        <MessageCircle /> {row.alreadySent ? 'Enviado' : 'Enviar'}
      </Button>
    </div>
  );
}

function History() {
  const [search, setSearch] = useState('');
  const { data } = useSWR<{ history: { id: string; kind: Kind; status: 'SENT' | 'FAILED'; contactName: string | null; amount: number | null; balance: number | null; reason: string | null; sentBy: string | null; conversationId: string | null; createdAt: string }[] }>(
    `/charges/history?take=100${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`,
    fetcher,
  );
  return (
    <CardContent className="grid gap-3 pt-4">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome da cliente" className="w-64" aria-label="Buscar no histórico" />
      {data?.history.length === 0 && <p className="py-4 text-sm text-muted-foreground">Nenhuma cobrança enviada ainda.</p>}
      <div className="divide-y rounded-lg border empty:hidden">
        {data?.history.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span className="min-w-0">
              <b className="font-medium">{h.contactName}</b> · {KIND_LABEL[h.kind]}
              {h.amount !== null ? ` · ${fmtMoney(h.amount)}` : ''}
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

function ConfigTab({ data, refresh }: { data: Data; refresh: () => void }) {
  const [draft, setDraft] = useState<Config | null>(null);
  const cfg = draft ?? data.config;
  const [busy, setBusy] = useState<'save' | 'tpl' | null>(null);
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setDraft({ ...cfg, [k]: v });
  const missing = data.kinds.filter((k) => !k.template);

  async function save() {
    setBusy('save');
    try {
      await api('/charges/config', { method: 'PUT', body: cfg });
      toast.success('Configurações salvas');
      setDraft(null);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function createTemplates() {
    setBusy('tpl');
    try {
      const r = await api<{ results: { name: string; error?: string }[] }>('/charges/templates', { method: 'POST' });
      const errs = r.results.filter((x) => x.error);
      if (errs.length) toast.error(errs.map((x) => `${x.name}: ${x.error}`).join('\n'));
      else toast.success('Templates enviados para a Meta aprovar.');
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
        <Field label="Chave Pix" htmlFor="pix" hint="Vai no lembrete e no vence hoje.">
          <Input id="pix" value={cfg.pixKey} onChange={(e) => set('pixKey', e.target.value)} placeholder="CNPJ, e-mail ou telefone" />
        </Field>
        <Field label="Contas emitidas a partir de" htmlFor="cutoff" hint="Contas emitidas antes não entram na cobrança (mesmo corte do painel).">
          <Input id="cutoff" type="date" value={cfg.cutoff} onChange={(e) => set('cutoff', e.target.value)} className="w-48" />
        </Field>
        <Field label="Lembrete quantos dias antes" htmlFor="days">
          <Input id="days" type="number" min={1} max={10} value={cfg.reminderDays} onChange={(e) => set('reminderDays', Number(e.target.value) || 2)} className="w-24" />
        </Field>
        <Field label="Conversas de cobrança ficam com" htmlFor="owner" hint="Quando a cliente responder (comprovante), a conversa já está com essa pessoa.">
          <Select id="owner" value={cfg.ownerUserId ?? ''} onChange={(e) => set('ownerUserId', e.target.value || null)}>
            <option value="">Quem enviou</option>
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
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
        <Button onClick={save} loading={busy === 'save'} disabled={!draft} className="justify-self-start">
          <Save /> Salvar
        </Button>
      </div>
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium">Templates</p>
        {missing.length > 0 && (
          <Button size="sm" variant="outline" onClick={createTemplates} loading={busy === 'tpl'} className="justify-self-start">
            <FileText /> Criar templates sugeridos ({missing.length})
          </Button>
        )}
        {data.kinds.map((k) => (
          <div key={k.key} className="grid gap-1 rounded-lg border p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <b className="font-medium">{k.label}</b>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{cfg.templates[k.key]}</code>
              {k.template ? <Badge tone={k.template.status === 'APPROVED' ? 'success' : k.template.status === 'REJECTED' ? 'danger' : 'warning'}>{k.template.status === 'APPROVED' ? 'aprovado' : k.template.status === 'REJECTED' ? 'recusado' : 'em análise'}</Badge> : <Badge tone="danger">não existe</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">{k.suggested.body}</p>
            {k.template?.rejectedReason && <p className="text-xs text-destructive">Motivo da Meta: {k.template.rejectedReason}</p>}
          </div>
        ))}
      </div>
    </CardContent>
  );
}

export default function CobrancaPage() {
  const { data, error, mutate } = useSWR<Data>('/charges', fetcher, { refreshInterval: 60_000 });
  const [tab, setTab] = useState<Tab>('atraso');
  const [sending, setSending] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmMany, setConfirmMany] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'many' | null>(null);

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  const rows: Row[] = tab === 'lembrete' || tab === 'hoje' || tab === 'atraso' || tab === 'pagos' ? data[tab] : [];
  const pending = (rs: Row[]) => rs.filter((r) => !r.alreadySent).length;
  const chosen = rows.filter((r) => selected.has(r.key));
  const total = (rs: Row[]) => rs.reduce((a, r) => a + r.amount, 0);

  async function sync() {
    setBusy('sync');
    try {
      const r = await api<{ open: number; newPayments: number }>('/charges/sync', { method: 'POST' });
      toast.success(`${r.open} parcela(s) em aberto${r.newPayments ? ` · ${r.newPayments} pagamento(s) novo(s)` : ''}`);
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
      const r = await api<{ sent: number; results: { status: string; reason?: string }[] }>('/charges/send-many', { method: 'POST', body: { keys: chosen.map((c) => c.key) } });
      const fails = r.results.filter((x) => x.status !== 'SENT');
      toast.success(`${r.sent} mensagem(ns) enviada(s)`);
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
        title="Cobrança"
        description="Parcelas do crediário direto das contas a receber do Bling. Nada sai sozinho: cada mensagem é enviada com um clique. Quando a cliente responder com o comprovante, a conversa cai na Inbox com o nome dela."
        actions={
          <Button variant="outline" onClick={sync} loading={busy === 'sync'} disabled={!data.blingConnected}>
            <RefreshCw /> Atualizar do Bling
          </Button>
        }
      />
      {!data.blingConnected && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0" /> O Bling não está conectado. Conecte em <Link href="/produtos" className="font-semibold underline">Produtos</Link>.
        </p>
      )}
      {data.sync.lastError && <p className="mb-4 rounded-lg bg-danger-soft px-4 py-3 text-sm">{data.sync.lastError}</p>}
      <p className="mb-3 text-xs text-muted-foreground">
        {data.sync.lastSyncAt ? `Atualizado do Bling ${timeAgo(data.sync.lastSyncAt)} (a cada 15 min).` : 'Ainda não foi lido do Bling. Clique em Atualizar do Bling.'}
        {data.sync.unknownRemaining > 0 && ` ${data.sync.unknownRemaining} parcela(s) paga(s) em parte sem o saldo no Bling: confira antes de enviar.`}
      </p>

      <Card>
        <div className="-mb-px flex gap-1 overflow-x-auto border-b px-2 pt-2 [scrollbar-width:none]">
          {TABS.map((t) => {
            const list = t.key === 'lembrete' || t.key === 'hoje' || t.key === 'atraso' || t.key === 'pagos' ? data[t.key] : null;
            const n = list ? pending(list) : 0;
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
                {t.key === 'lembrete' ? `Vence ${ddmm(addDaysYmd(data.today, data.config.reminderDays))}` : t.label}
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
              <CardDescription>
                {rows.length} cliente(s) · {fmtMoney(total(rows))}
                {tab === 'atraso' ? ' em atraso' : tab === 'pagos' ? ' recebidos' : ''}
              </CardDescription>
              {chosen.length > 0 && (
                <Button size="sm" onClick={() => setConfirmMany(true)}>
                  <Send /> Enviar para {chosen.length} selecionada(s)
                </Button>
              )}
            </CardHeader>
            <div className="divide-y border-t">
              {rows.map((r) => (
                <RowItem
                  key={r.key}
                  row={r}
                  selected={selected.has(r.key)}
                  onToggle={() => {
                    const next = new Set(selected);
                    if (next.has(r.key)) next.delete(r.key);
                    else next.add(r.key);
                    setSelected(next);
                  }}
                  onSend={() => setSending(r)}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <SendDialog row={sending} onClose={() => setSending(null)} onSent={() => void mutate()} />
      <Dialog open={confirmMany} onOpenChange={setConfirmMany}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar {chosen.length} mensagem(ns)?</DialogTitle>
            <DialogDescription>Cada cliente recebe a sua mensagem com os próprios valores. Não dá para desfazer.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border text-sm">
            {chosen.map((c) => (
              <li key={c.key} className="flex justify-between gap-2 px-3 py-2">
                <span>{c.name}</span>
                <span className="text-muted-foreground">{fmtMoney(c.amount)}</span>
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

function addDaysYmd(ymd: string, n: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
