'use client';

import { CheckCircle2, Link2, Link2Off, Package, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import useSWR, { mutate as globalMutate } from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select, Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { BlingStatus, ProductDetail, ProductItem } from '@/lib/types';
import { cn, fmtDateTime, fmtInt, fmtMoney, timeAgo } from '@/lib/utils';

const GENDERS = [
  { key: '', label: 'Todos' },
  { key: 'feminino', label: 'Feminino' },
  { key: 'masculino', label: 'Masculino' },
  { key: 'unissex', label: 'Unissex' },
  { key: 'infantil', label: 'Infantil' },
] as const;

const FORMAT: Record<string, string> = { E: 'Kit', V: 'Com variações' };
const TRIGGER: Record<string, string> = { agendado: 'automática', manual: 'manual', conexao: 'ao conectar', cli: 'pelo terminal' };
const PAGE_SIZE = 24;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ProductImage({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={cn('grid place-items-center bg-muted text-muted-foreground', className)}>
        <Package className="size-8 opacity-50" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- links assinados do Bling (expiram), sem otimização do Next
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={cn('bg-muted object-cover', className)} />
  );
}

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) return <Badge tone="danger">Sem estoque</Badge>;
  return <Badge tone={stock <= 2 ? 'warning' : 'success'}>{fmtInt(stock)} em estoque</Badge>;
}

function ConnectionCard({ status, onChanged, onSyncRequested }: { status: BlingStatus; onChanged: () => void; onSyncRequested: () => void }) {
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const s = status.sync;

  async function connect() {
    setBusy('connect');
    try {
      const { url } = await api<{ url: string }>('/bling/connect', { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  }

  async function sync(full: boolean) {
    setBusy('sync');
    try {
      await api('/bling/sync', { method: 'POST', body: { full } });
      toast.success('Sincronização iniciada');
      onSyncRequested();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await api('/bling/disconnect', { method: 'POST' });
      toast.success('Bling desconectado. Os produtos já copiados continuam aqui.');
      setConfirmOff(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!status.configured) {
    return (
      <Card className="mb-5 flex gap-3 border-warning/40 p-4">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[oklch(0.6_0.13_60)]" />
        <div className="text-sm">
          <p className="font-semibold">Falta configurar o app do Bling</p>
          <p className="mt-1 text-muted-foreground">
            Preencha <code>BLING_CLIENT_ID</code> e <code>BLING_CLIENT_SECRET</code> no <code>.env</code> e reinicie a API. No app do Bling, o link de
            redirecionamento deve ser <code className="break-all">{status.redirectUri}</code>.
          </p>
        </div>
      </Card>
    );
  }

  if (!status.connected) {
    return (
      <Card className="mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <p className="font-semibold">Bling não conectado</p>
          <p className="mt-0.5 text-muted-foreground">
            Conecte para copiar o catálogo (atualizado a cada {status.intervalMinutes} min) e permitir a consulta de pedidos.
          </p>
        </div>
        <Button onClick={connect} loading={busy === 'connect'} className="shrink-0">
          <Link2 /> Conectar Bling
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mb-5 flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 gap-3 text-sm">
        {s.running ? (
          <RefreshCw className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
        ) : s.ok === false ? (
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[oklch(0.55_0.12_155)]" />
        )}
        <div className="min-w-0">
          <p className="font-semibold">
            Bling conectado
            <span className="font-normal text-muted-foreground"> · {fmtInt(status.products.active)} produtos ativos, {fmtInt(status.products.inStock)} com estoque</span>
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {s.running
              ? `Sincronizando agora (começou ${timeAgo(s.startedAt)})…`
              : s.finishedAt
                ? s.ok
                  ? `Última sincronização ${timeAgo(s.finishedAt)} (${TRIGGER[s.trigger ?? ''] ?? s.trigger}): ${s.result?.created ?? 0} novos, ${s.result?.updated ?? 0} atualizados, ${s.result?.deactivated ?? 0} saíram de linha.`
                  : `A última sincronização falhou ${timeAgo(s.finishedAt)}: ${s.error}`
                : 'Ainda não sincronizado.'}{' '}
            Automática a cada {status.intervalMinutes} min.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" onClick={() => sync(false)} loading={busy === 'sync'} disabled={s.running}>
          <RefreshCw /> Sincronizar agora
        </Button>
        <Button variant="ghost" onClick={() => setConfirmOff(true)}>
          <Link2Off /> Desconectar
        </Button>
      </div>

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desconectar o Bling?</DialogTitle>
            <DialogDescription>
              O catálogo para de ser atualizado e o bot não consegue consultar pedidos até você conectar de novo. Os produtos já copiados continuam
              aqui.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOff(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={disconnect} loading={busy === 'disconnect'}>
              Desconectar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ProductDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useSWR<{ product: ProductDetail }>(id ? `/products/${id}` : null, fetcher);
  const p = data?.product;
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {!p ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{p.name}</DialogTitle>
              <DialogDescription>
                {p.sku ? `Código ${p.sku} · ` : ''}
                {p.category ?? 'Sem categoria'} · atualizado {timeAgo(p.syncedAt)}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
              <ProductImage src={p.imageUrl} alt={p.name} className="aspect-square w-full rounded-lg sm:w-[180px]" />
              <div className="grid content-start gap-2">
                <p className="text-2xl font-semibold">{fmtMoney(p.price)}</p>
                <div className="flex flex-wrap gap-1.5">
                  <StockBadge stock={p.stock} />
                  {p.gender && <Badge tone="brand">{p.gender}</Badge>}
                  {p.format && FORMAT[p.format] && <Badge>{FORMAT[p.format]}</Badge>}
                  {!p.active && <Badge tone="danger">Inativo no Bling</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">É este o texto (já sem HTML) que o bot lê para responder sobre o produto.</p>
              </div>
            </div>
            <div className="max-h-[45dvh] overflow-y-auto whitespace-pre-line rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
              {p.descriptionText ?? <span className="text-muted-foreground">Sem descrição no Bling. O bot só vai saber nome, preço e estoque.</span>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProdutosContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [gender, setGender] = useState('');
  const [inStock, setInStock] = useState(false);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(query.trim());

  // Depois de pedir um sync, consulta rápido até aparecer um resultado mais novo que o pedido.
  const [syncRequestedAt, setSyncRequestedAt] = useState<number | null>(null);
  const { data: status, mutate: refreshStatus } = useSWR<BlingStatus>('/bling/status', fetcher, {
    refreshInterval: (s) => {
      const waiting = syncRequestedAt !== null && (!s?.sync.finishedAt || Date.parse(s.sync.finishedAt) < syncRequestedAt);
      return s?.sync.running || (waiting && Date.now() - syncRequestedAt < 120_000) ? 2000 : 30_000;
    },
  });
  const { data: cats } = useSWR<{ categories: { category: string; count: number }[] }>('/products/categories', fetcher);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (q) qs.set('q', q);
  if (category) qs.set('category', category);
  if (gender) qs.set('gender', gender);
  if (inStock) qs.set('inStock', 'true');
  const { data, error, mutate } = useSWR<{ products: ProductItem[]; total: number }>(`/products?${qs.toString()}`, fetcher, {
    keepPreviousData: true,
  });

  // Volta do Bling (callback) com ?bling=conectado | ?bling=erro&motivo=...
  useEffect(() => {
    const result = params.get('bling');
    if (!result) return;
    if (result === 'conectado') toast.success('Bling conectado! Copiando o catálogo…');
    else toast.error(params.get('motivo') ?? 'Não foi possível conectar o Bling.');
    router.replace('/produtos');
  }, [params, router]);

  // Quando um sync termina, recarrega a lista e as categorias.
  const finishedAt = status?.sync.finishedAt;
  const lastFinished = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastFinished.current && finishedAt && finishedAt !== lastFinished.current) {
      void mutate();
      void globalMutate('/products/categories');
    }
    lastFinished.current = finishedAt;
  }, [finishedAt, mutate]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const setFilter = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Produtos" description="Cópia do catálogo do Bling. O bot só fala de produtos, preços e estoque que estão aqui." />

      {status && (
        <ConnectionCard
          status={status}
          onChanged={() => void refreshStatus()}
          onSyncRequested={() => {
            setSyncRequestedAt(Date.now());
            void refreshStatus();
          }}
        />
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_260px_auto] md:items-center">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setFilter(setQuery)(e.target.value)}
            placeholder="Buscar por nome, código, nota ou família (ex.: baunilha)"
            className="pl-9"
            aria-label="Buscar produtos"
          />
        </div>
        <Select value={category} onChange={(e) => setFilter(setCategory)(e.target.value)} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {cats?.categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.count})
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="instock" checked={inStock} onCheckedChange={setFilter(setInStock)} />
          <Label htmlFor="instock" className="whitespace-nowrap">
            Só com estoque
          </Label>
        </div>
      </div>

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
        {GENDERS.map((g) => (
          <button
            key={g.key}
            role="tab"
            aria-selected={gender === g.key}
            onClick={() => setFilter(setGender)(g.key)}
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              gender === g.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
            )}
          >
            {g.label}
          </button>
        ))}
        {data && <span className="ml-auto self-center whitespace-nowrap pl-3 text-sm text-muted-foreground">{fmtInt(data.total)} produtos</span>}
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data?.products.length === 0 && (
        <Card className="grid place-items-center gap-2 border-dashed p-10 text-center">
          <Package className="size-8 text-muted-foreground" />
          <p className="font-semibold">{q || category || gender || inStock ? 'Nada encontrado com esses filtros' : 'Nenhum produto ainda'}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {status?.connected ? 'Tente outra busca ou clique em “Sincronizar agora”.' : 'Conecte o Bling para copiar o catálogo.'}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {data?.products.map((p) => (
          <button
            key={p.id}
            onClick={() => setOpenId(p.id)}
            className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ProductImage src={p.imageUrl} alt={p.name} className="aspect-square w-full" />
            <div className="flex flex-1 flex-col gap-1.5 p-3">
              <p className="line-clamp-2 text-sm font-semibold leading-snug">{p.name}</p>
              {p.category && <p className="truncate text-xs text-muted-foreground">{p.category.split(' > ').pop()}</p>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-1.5 pt-1">
                <span className="font-semibold">{fmtMoney(p.price)}</span>
                <StockBadge stock={p.stock} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {data && totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {page} de {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((n) => n + 1)}>
            Próxima
          </Button>
        </div>
      )}

      {status?.connected && status.tokenExpiresAt && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Conectado em {fmtDateTime(status.connectedAt)} · o acesso é renovado sozinho
          {status.lastRefreshAt ? ` (última renovação ${timeAgo(status.lastRefreshAt)})` : ''}.
        </p>
      )}

      <ProductDialog id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

export default function ProdutosPage() {
  return (
    <Suspense>
      <ProdutosContent />
    </Suspense>
  );
}
