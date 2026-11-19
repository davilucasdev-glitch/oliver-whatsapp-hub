'use client';

import { AlertTriangle, FileDown, FileText, RefreshCw, Save, Search, Send, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { formatPhone } from '@/components/contact-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { api, ApiError, fetcher } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney, timeAgo } from '@/lib/utils';

interface Order {
  id: string;
  numero: number;
  data: string;
  total: number;
  situacao: string;
  supplier: { id: string; nome: string; phone: string | null };
  lastSend: { status: 'SENT' | 'FAILED'; at: string; reason: string | null; conversationId: string | null } | null;
}
interface Data {
  connected: boolean;
  blingError: string | null;
  orders: Order[];
  config: { ownerUserId: string | null; phoneNumberId: string | null; templates: { PEDIDO_COMPRA: string; COTACAO: string } };
  appIdSet: boolean;
  kinds: { key: 'PEDIDO_COMPRA' | 'COTACAO'; label: string; suggested: { body: string }; template: { name: string; status: string; rejectedReason: string | null } | null }[];
  history: { id: string; kind: 'PEDIDO_COMPRA' | 'COTACAO'; status: 'SENT' | 'FAILED'; supplierName: string; phone: string; purchaseOrderNumber: number | null; filename: string | null; reason: string | null; conversationId: string | null; sentBy: string | null; createdAt: string }[];
}

function QuoteCard({ onSent }: { onSent: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; nome: string; documento: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; nome: string; phone: string | null } | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'search' | 'send' | null>(null);

  async function search() {
    if (q.trim().length < 2) return;
    setBusy('search');
    try {
      const r = await api<{ suppliers: { id: string; nome: string; documento: string | null }[] }>(`/suppliers/search?q=${encodeURIComponent(q.trim())}`);
      setResults(r.suppliers);
      if (!r.suppliers.length) toast.info('Ninguém com esse nome no Bling. Digite o WhatsApp abaixo.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function pick(id: string) {
    try {
      const r = await api<{ supplier: { id: string; nome: string; phone: string | null } }>(`/suppliers/contact/${id}`);
      setPicked(r.supplier);
      setResults([]);
      setPhone(r.supplier.phone ?? '');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function send() {
    if (!file) return toast.error('Escolha o PDF da cotação.');
    setBusy('send');
    try {
      const form = new FormData();
      if (picked) form.append('supplierBlingId', picked.id);
      if (phone.trim()) form.append('phone', phone.trim());
      if (!picked && name.trim()) form.append('name', name.trim());
      form.append('file', file);
      const res = await fetch('/api/suppliers/quote', { method: 'POST', body: form, headers: { 'x-oliver-panel': '1' } });
      const data = (await res.json().catch(() => ({}))) as { status?: string; reason?: string; error?: string };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Erro ${res.status}`);
      if (data.status === 'SENT') {
        toast.success('Cotação enviada');
        setFile(null);
        setPicked(null);
        setPhone('');
        setName('');
        if (fileRef.current) fileRef.current.value = '';
        onSent();
      } else toast.error(`Não foi: ${data.reason}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enviar cotação</CardTitle>
        <CardDescription>Baixe o PDF da cotação no painel (compras.php ou compra urgente) e envie aqui pelo número oficial. A resposta do fornecedor cai na Inbox com o nome dele.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!picked ? (
          <>
            <div className="flex gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void search())} placeholder="Fornecedor no Bling (ex.: Beauty Mania)" aria-label="Buscar fornecedor no Bling" />
              <Button variant="outline" onClick={search} loading={busy === 'search'}>
                <Search /> Buscar
              </Button>
            </div>
            {results.length > 0 && (
              <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
                {results.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => void pick(r.id)} className="w-full cursor-pointer px-3 py-2 text-left hover:bg-muted">
                      {r.nome}
                      {r.documento && <span className="text-xs text-muted-foreground"> · {r.documento}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Field label="Ou o nome (se não estiver no Bling)" htmlFor="q-name">
              <Input id="q-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        ) : (
          <p className="flex items-center justify-between gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-sm">
            <b className="font-medium">{picked.nome}</b>
            <button onClick={() => setPicked(null)} className="cursor-pointer text-xs text-primary hover:underline">
              trocar
            </button>
          </p>
        )}
        <Field label="WhatsApp do fornecedor" htmlFor="q-phone" hint={picked && !picked.phone ? 'O cadastro no Bling não tem celular: digite o número.' : undefined}>
          <Input id="q-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(45) 99999-9999" />
        </Field>
        <Field label="PDF da cotação" htmlFor="q-file">
          <input ref={fileRef} id="q-file" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-sm" />
        </Field>
        <Button onClick={send} loading={busy === 'send'} disabled={!file || (!picked && !name.trim())} className="justify-self-start">
          <Upload /> Enviar cotação
        </Button>
      </CardContent>
    </Card>
  );
}

function ConfigCard({ data, refresh }: { data: Data; refresh: () => void }) {
  const { data: team } = useSWR<{ members: { id: string; name: string }[] }>('/team/members', fetcher);
  const [draft, setDraft] = useState<Data['config'] | null>(null);
  const cfg = draft ?? data.config;
  const [busy, setBusy] = useState<'save' | 'tpl' | null>(null);
  const missing = data.kinds.filter((k) => !k.template).length;
  async function run(kind: 'save' | 'tpl') {
    setBusy(kind);
    try {
      if (kind === 'save') {
        await api('/suppliers/config', { method: 'PUT', body: cfg });
        toast.success('Salvo');
        setDraft(null);
      } else {
        const r = await api<{ results: { name: string; error?: string }[] }>('/suppliers/templates', { method: 'POST' });
        const errs = r.results.filter((x) => x.error);
        if (errs.length) toast.error(errs.map((x) => `${x.name}: ${x.error}`).join('\n'));
        else toast.success('Templates enviados para a Meta aprovar.');
      }
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configurações</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Field label="Conversas com fornecedor ficam com" htmlFor="sup-owner" hint="Pelo documento: a Ellen.">
          <Select id="sup-owner" value={cfg.ownerUserId ?? ''} onChange={(e) => setDraft({ ...cfg, ownerUserId: e.target.value || null })}>
            <option value="">Quem enviou</option>
            {team?.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" onClick={() => void run('save')} loading={busy === 'save'} disabled={!draft} className="justify-self-start">
          <Save /> Salvar
        </Button>
        <p className="text-sm font-medium">Templates (com o PDF no cabeçalho)</p>
        {!data.appIdSet && (
          <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Para criar estes templates, preencha META_APP_ID no .env (ID do app em developers.facebook.com → Configurações → Básico).
          </p>
        )}
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
            <p className="text-xs">{k.suggested.body}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function FornecedoresPage() {
  const [refresh, setRefresh] = useState(false);
  const { data, error, mutate, isValidating } = useSWR<Data>(`/suppliers${refresh ? '?refresh=1' : ''}`, fetcher, { revalidateOnFocus: false });
  const [sending, setSending] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Consultando o Bling…</p>;

  async function send() {
    if (!sending) return;
    setBusy(true);
    try {
      const r = await api<{ status: string; reason?: string }>(`/suppliers/purchase-orders/${sending.id}/send`, { method: 'POST' });
      if (r.status === 'SENT') toast.success(`Pedido ${sending.numero} enviado para ${sending.supplier.nome}`);
      else toast.error(`Não foi: ${r.reason}`);
      setSending(null);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Pedido de compra do Bling em PDF (com a logo) e cotação pelo número oficial. Sempre com um clique; a resposta do fornecedor cai na Inbox."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setRefresh(true);
              void mutate();
            }}
            loading={isValidating}
          >
            <RefreshCw /> Atualizar do Bling
          </Button>
        }
      />
      {!data.connected && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0" /> O Bling não está conectado. Conecte em <Link href="/produtos" className="font-semibold underline">Produtos</Link>.
        </p>
      )}
      {data.blingError && <p className="mb-4 rounded-lg bg-danger-soft px-4 py-3 text-sm">{data.blingError}</p>}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Pedidos de compra (últimos 45 dias)</CardTitle>
              <CardDescription>Lançados no Bling. Confira o PDF antes de enviar.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {data.orders.length === 0 && <p className="px-5 pb-5 text-sm text-muted-foreground">Nenhum pedido de compra nos últimos 45 dias.</p>}
              <div className="divide-y border-t empty:hidden">
                {data.orders.map((o) => (
                  <div key={o.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        Pedido de compra nº {o.numero} <Badge>{o.situacao}</Badge>
                        {o.lastSend?.status === 'SENT' && <Badge tone="success">enviado {timeAgo(o.lastSend.at)}</Badge>}
                        {o.lastSend?.status === 'FAILED' && <Badge tone="danger">falhou</Badge>}
                      </p>
                      <p className="text-sm">
                        {o.supplier.nome} · {fmtMoney(o.total)} · {fmtDate(o.data)}
                      </p>
                      <p className="text-xs text-muted-foreground">{o.supplier.phone ? formatPhone(o.supplier.phone) : 'fornecedor sem celular no Bling'}</p>
                      {o.lastSend?.status === 'FAILED' && o.lastSend.reason && <p className="text-xs text-destructive">{o.lastSend.reason}</p>}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" asChild>
                        <a href={`/api/suppliers/purchase-orders/${o.id}/pdf`} target="_blank" rel="noreferrer">
                          <FileDown /> PDF
                        </a>
                      </Button>
                      <Button size="sm" onClick={() => setSending(o)} disabled={!o.supplier.phone}>
                        <Send /> Enviar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Histórico</CardTitle>
            </CardHeader>
            <CardContent>
              {data.history.length === 0 && <p className="text-sm text-muted-foreground">Nada enviado ainda.</p>}
              <div className="divide-y rounded-lg border empty:hidden">
                {data.history.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                    <span>
                      <b className="font-medium">{h.supplierName}</b> · {h.kind === 'PEDIDO_COMPRA' ? `pedido de compra nº ${h.purchaseOrderNumber}` : 'cotação'}
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
          </Card>
        </div>
        <div className="grid content-start gap-4">
          <QuoteCard onSent={() => void mutate()} />
          <ConfigCard data={data} refresh={() => void mutate()} />
        </div>
      </div>

      <Dialog open={Boolean(sending)} onOpenChange={(o) => !o && setSending(null)}>
        <DialogContent>
          {sending && (
            <>
              <DialogHeader>
                <DialogTitle>Enviar o pedido de compra nº {sending.numero}?</DialogTitle>
                <DialogDescription>
                  Para {sending.supplier.nome}, no WhatsApp {sending.supplier.phone ? formatPhone(sending.supplier.phone) : '—'}, com o PDF do pedido.
                </DialogDescription>
              </DialogHeader>
              <a href={`/api/suppliers/purchase-orders/${sending.id}/pdf`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-medium text-primary hover:underline">
                <FileDown className="size-4" /> Conferir o PDF
              </a>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSending(null)}>
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
    </>
  );
}
