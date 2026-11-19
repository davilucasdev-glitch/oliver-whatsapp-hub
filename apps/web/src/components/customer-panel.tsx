'use client';

import { AlertTriangle, IdCard, Link2, RefreshCw, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { Order } from '@/components/bling-orders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { OrderSummary } from '@/lib/types';
import { cn, fmtMoney, timeAgo } from '@/lib/utils';

interface Customer {
  contact: {
    id: string;
    name: string | null;
    phone: string;
    document: string | null;
    blingContactId: string | null;
  };
  connected: boolean;
  bling: { id: string; nome: string; numeroDocumento: string | null } | null;
  hint: string | null;
  blingError: string | null;
  orders: OrderSummary[];
  openOrder: OrderSummary | null;
  credit: {
    balance: number;
    balanceKnown: boolean;
    overdue: number;
    oldestDue: string | null;
    parcels: {
      vencimento: string;
      remaining: number;
      known: boolean;
      orderNumber: string | null;
      late: boolean;
    }[];
    more: number;
    lastCharge: { kind: string; at: string } | null;
    syncedAt: string | null;
  } | null;
  kanbanUrl: string | null;
}

const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const maskDoc = (d: string | null) => {
  const x = (d ?? '').replace(/\D/g, '');
  return x.length === 11 ? `***.${x.slice(3, 6)}.${x.slice(6, 9)}-**` : x.length === 14 ? `**.${x.slice(2, 5)}.${x.slice(5, 8)}/****-**` : null;
};

function Section({ title, icon: Icon, children, className }: { title: string; icon: typeof Wallet; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-2 border-b px-4 py-3.5 last:border-b-0', className)}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" /> {title}
      </h3>
      {children}
    </section>
  );
}

function KanbanSetup({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(current ?? '');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Link2 className="size-3.5" /> {current ? 'Trocar link do Kanban' : 'Ligar botão "Abrir no Kanban"'}
      </button>
    );
  }
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        api('/inbox/kanban-url', { method: 'PUT', body: { url } })
          .then(() => {
            toast.success('Link do Kanban salvo');
            setOpen(false);
            onSaved();
          })
          .catch((err: Error) => toast.error(err.message));
      }}
    >
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://.../kanban.php?pedido={numero}" className="h-8 text-xs" autoFocus />
      <p className="text-[11px] text-muted-foreground">Link do card no painel; {'{numero}'} vira o nº do pedido.</p>
      <div className="flex gap-2">
        <Button size="sm" type="submit">
          Salvar
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Quem é a cliente no Bling: cadastro, crediário, pedido em andamento e últimos pedidos. */
export function CustomerPanel({ conversationId, className, inDialog }: { conversationId: string; className?: string; inDialog?: boolean }) {
  const [refresh, setRefresh] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<Customer>(`/conversations/${conversationId}/customer${refresh ? '?refresh=1' : ''}`, fetcher, {
    revalidateOnFocus: false,
  });

  return (
    <div className={cn('flex min-h-0 flex-col overflow-y-auto bg-card', className)}>
      <div className={cn('flex items-center justify-between border-b px-4 py-3', inDialog && 'pr-12')}>
        <p className="font-display text-base font-semibold">Cliente</p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Atualizar dados do Bling"
          title="Atualizar dados do Bling"
          onClick={() => {
            setRefresh(true);
            void mutate();
          }}
        >
          <RefreshCw className={cn(isLoading && 'animate-spin')} />
        </Button>
      </div>
      {!data && !error && <p className="p-4 text-sm text-muted-foreground">Consultando o Bling…</p>}
      {error && <p className="p-4 text-sm text-destructive">{(error as Error).message}</p>}
      {data && (
        <>
          <Section title="Cadastro no Bling" icon={IdCard}>
            {!data.connected && <p className="text-sm text-muted-foreground">Bling não conectado.</p>}
            {data.blingError && <p className="text-sm text-destructive">{data.blingError}</p>}
            {data.bling ? (
              <div>
                <p className="font-medium">{data.bling.nome}</p>
                {maskDoc(data.bling.numeroDocumento) && <p className="text-xs text-muted-foreground">CPF/CNPJ {maskDoc(data.bling.numeroDocumento)}</p>}
              </div>
            ) : (
              data.connected && !data.blingError && <p className="text-sm text-muted-foreground">{data.hint}</p>
            )}
            <Link href={`/contatos/${data.contact.id}`} className="text-xs font-medium text-primary hover:underline">
              Ficha do contato
            </Link>
          </Section>

          {data.credit && (
            <Section title="Crediário" icon={Wallet}>
              {data.credit.balance > 0 ? (
                <>
                  <p className="text-sm">
                    Saldo em aberto{' '}
                    <b className="text-base">{data.credit.balanceKnown ? fmtMoney(data.credit.balance) : `≈ ${fmtMoney(data.credit.balance)}`}</b>
                  </p>
                  {!data.credit.balanceKnown && <p className="text-xs text-muted-foreground">Tem parcela paga em parte: confira no crediário.</p>}
                  {data.credit.overdue > 0 && (
                    <p className="flex items-center gap-1.5 text-sm text-[oklch(0.45_0.17_25)]">
                      <AlertTriangle className="size-3.5" /> {fmtMoney(data.credit.overdue)} em atraso desde {ddmm(data.credit.oldestDue!)}
                    </p>
                  )}
                  <ul className="grid gap-1 text-xs">
                    {data.credit.parcels.map((p, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className={cn(p.late && 'font-semibold text-[oklch(0.45_0.17_25)]')}>
                          {ddmm(p.vencimento)}
                          {p.orderNumber ? ` · pedido ${p.orderNumber}` : ''}
                        </span>
                        <span>{p.known ? fmtMoney(p.remaining) : `≈ ${fmtMoney(p.remaining)}`}</span>
                      </li>
                    ))}
                    {data.credit.more > 0 && <li className="text-muted-foreground">+ {data.credit.more} parcela(s)</li>}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Nada em aberto no crediário.</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                {data.credit.lastCharge ? `Última cobrança ${timeAgo(data.credit.lastCharge.at)}. ` : ''}
                {data.credit.syncedAt ? `Bling lido ${timeAgo(data.credit.syncedAt)}.` : 'Contas a receber ainda não lidas.'}{' '}
                <Link href="/cobranca" className="font-medium text-primary hover:underline">
                  Cobrança
                </Link>
              </p>
            </Section>
          )}

          {data.openOrder && (
            <Section title="Pedido em andamento" icon={IdCard} className="bg-secondary/40">
              <ul>
                <Order o={data.openOrder} kanbanUrl={data.kanbanUrl} />
              </ul>
            </Section>
          )}

          {data.orders.length > 0 && (
            <Section title="Últimos pedidos" icon={IdCard}>
              <ul className="grid gap-2">
                {data.orders
                  .filter((o) => o.id !== data.openOrder?.id)
                  .map((o) => (
                    <Order key={o.id} o={o} kanbanUrl={data.kanbanUrl} />
                  ))}
              </ul>
            </Section>
          )}
          {data.bling && data.orders.length === 0 && (
            <Section title="Pedidos" icon={IdCard}>
              <p className="text-sm text-muted-foreground">Nenhum pedido no Bling.</p>
            </Section>
          )}
          <div className="px-4 py-3">
            <KanbanSetup current={data.kanbanUrl} onSaved={() => void mutate()} />
          </div>
          {data.contact.blingContactId && <Badge className="mx-4 mb-3 self-start">Bling #{data.contact.blingContactId}</Badge>}
        </>
      )}
    </div>
  );
}
