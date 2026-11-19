'use client';

import { PackageSearch, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetcher } from '@/lib/api';
import type { ContactBlingInfo, OrderSummary } from '@/lib/types';
import { fmtDate, fmtMoney } from '@/lib/utils';

export function situationTone(s: string): 'success' | 'danger' | 'warning' | 'neutral' {
  const n = s.toLowerCase();
  if (n.includes('cancel')) return 'danger';
  if (n.includes('atendido') || n.includes('entregue') || n.includes('conclu')) return 'success';
  if (n.includes('aberto') || n.includes('andamento') || n.includes('aguard')) return 'warning';
  return 'neutral';
}

export function Order({ o, kanbanUrl }: { o: OrderSummary; kanbanUrl?: string | null }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          Pedido {o.numero}
          {o.numeroLoja && <span className="font-normal text-muted-foreground"> · loja {o.numeroLoja}</span>}
        </p>
        <Badge tone={situationTone(o.situacao)}>{o.situacao}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtDate(o.data)} · {fmtMoney(o.total)}
        {o.dataPrevista && ` · previsto ${fmtDate(o.dataPrevista)}`}
        {o.notaFiscalEmitida && ' · NF emitida'}
      </p>
      <ul className="mt-2 grid gap-0.5 text-xs">
        {o.itens.map((i, idx) => (
          <li key={idx} className="truncate">
            {i.quantidade}× {i.descricao}
          </li>
        ))}
      </ul>
      {(o.transportadora || o.rastreios.length > 0) && (
        <p className="mt-2 flex items-center gap-1.5 text-xs">
          <Truck className="size-3.5 shrink-0 text-muted-foreground" />
          {o.transportadora ?? 'Envio'}
          {o.rastreios.length > 0 && <span className="font-mono">{o.rastreios.join(', ')}</span>}
        </p>
      )}
      {kanbanUrl && (
        <a href={kanbanUrl.replaceAll('{numero}', String(o.numero))} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-primary hover:underline">
          Abrir no Kanban ↗
        </a>
      )}
    </li>
  );
}

/** Vincula o contato ao cadastro do Bling (CPF/CNPJ ou telefone) e mostra os últimos pedidos. Só consulta ao clicar. */
export function BlingOrdersCard({ contactId, onLinked }: { contactId: string; onLinked?: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<ContactBlingInfo>(enabled ? `/contacts/${contactId}/bling` : null, fetcher, {
    revalidateOnFocus: false,
    onSuccess: (d) => d.linked && onLinked?.(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pedidos no Bling</CardTitle>
        <CardDescription>
          {data?.blingContact
            ? `Cadastro no Bling: ${data.blingContact.nome}${data.linked ? '' : ' (já vinculado a outro contato)'}`
            : 'Procura o cadastro pelo CPF/CNPJ ou pelo telefone e mostra os últimos pedidos.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!enabled && (
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setEnabled(true)}>
            <PackageSearch /> Buscar pedidos
          </Button>
        )}
        {isLoading && <p className="text-sm text-muted-foreground">Consultando o Bling…</p>}
        {error && (
          <div className="grid gap-2 text-sm">
            <p className="text-destructive">{(error as Error).message}</p>
            {(error as Error).message.includes('conect') && (
              <Link href="/produtos" className="text-primary underline-offset-4 hover:underline">
                Ir para Produtos e conectar o Bling
              </Link>
            )}
          </div>
        )}
        {data && !data.blingContact && <p className="text-sm text-muted-foreground">{data.hint}</p>}
        {data?.blingContact && data.orders.length === 0 && <p className="text-sm text-muted-foreground">Nenhum pedido neste cadastro.</p>}
        {data && data.orders.length > 0 && (
          <ul className="grid gap-2">
            {data.orders.map((o) => (
              <Order key={o.id} o={o} />
            ))}
          </ul>
        )}
        {data && (
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => void mutate()}>
            Consultar de novo
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
