'use client';

import { ArrowLeft, Download, MessageSquarePlus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { BlingOrdersCard } from '@/components/bling-orders';
import { ConsentBadge, displayName, formatPhone } from '@/components/contact-bits';
import { TagPicker } from '@/components/tag-picker';
import { TemplateSendForm } from '@/components/template-send';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { ContactDetail, Tag } from '@/lib/types';
import { fmtDateTime, timeAgo } from '@/lib/utils';

type Modal = 'optin' | 'optout' | 'delete' | 'start' | null;

export default function ContatoPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, mutate, error } = useSWR<{ contact: ContactDetail }>(`/contacts/${id}`, fetcher);
  const { data: tagData } = useSWR<{ tags: Tag[] }>('/tags', fetcher);
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);

  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const c = data.contact;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    try {
      await api(`/contacts/${id}`, {
        method: 'PATCH',
        body: { name: f.get('name') || null, email: f.get('email') || '', document: f.get('document') || null },
      });
      toast.success('Dados salvos');
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function setTags(tagIds: string[]) {
    try {
      await api(`/contacts/${id}`, { method: 'PATCH', body: { tagIds } });
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function consent(e: React.FormEvent<HTMLFormElement>, action: 'OPT_IN' | 'OPT_OUT') {
    e.preventDefault();
    const source = String(new FormData(e.currentTarget).get('source') ?? '');
    try {
      await api(`/contacts/${id}/consent`, { method: 'POST', body: { action, source } });
      toast.success(action === 'OPT_IN' ? 'Opt-in registrado' : 'Opt-out registrado: o contato não receberá campanhas');
      setModal(null);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const confirmPhone = String(new FormData(e.currentTarget).get('confirmPhone') ?? '');
    try {
      await api(`/contacts/${id}/delete`, { method: 'POST', body: { confirmPhone } });
      toast.success('Contato e todo o histórico excluídos');
      router.replace('/contatos');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <Link href="/contatos" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Contatos
      </Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-[26px] font-semibold leading-tight">{displayName(c)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {formatPhone(c.phone)} · cliente desde {fmtDateTime(c.createdAt).split(' ')[0]} <ConsentBadge c={c} />
          </p>
        </div>
        <Button onClick={() => setModal('start')}>
          <MessageSquarePlus /> Iniciar conversa
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Dados</CardTitle>
            </CardHeader>
            <CardContent>
              <form key={`${c.name}|${c.email}|${c.document}`} onSubmit={save} className="grid gap-4 sm:grid-cols-2">
                <Field label="Nome" htmlFor="name">
                  <Input id="name" name="name" defaultValue={c.name ?? ''} />
                </Field>
                <Field label="E-mail" htmlFor="email">
                  <Input id="email" name="email" type="email" defaultValue={c.email ?? ''} />
                </Field>
                <Field label="CPF/CNPJ" htmlFor="document" hint="Usado para o bot consultar pedidos no Bling.">
                  <Input id="document" name="document" inputMode="numeric" defaultValue={c.document ?? ''} />
                </Field>
                <div className="flex items-end">
                  <Button type="submit" loading={saving} variant="secondary">
                    Salvar dados
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
              <CardDescription>Clique para marcar ou desmarcar.</CardDescription>
            </CardHeader>
            <CardContent>
              <TagPicker tags={tagData?.tags ?? []} selected={c.tags.map((t) => t.id)} onChange={setTags} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Conversas</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {c.conversations.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma conversa ainda.</p>}
              {c.conversations.map((conv) => (
                <Link key={conv.id} href={`/inbox?c=${conv.id}`} className="flex items-center justify-between rounded-lg border px-3 py-2.5 hover:bg-muted/60">
                  <span className="text-sm font-medium">via {conv.phoneNumber.displayName}</span>
                  <span className="text-xs text-muted-foreground">
                    {conv.handler === 'BOT' ? 'Bot' : 'Humano'} · {timeAgo(conv.lastMessageAt)}
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>

          <BlingOrdersCard contactId={id} onLinked={() => void mutate()} />
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Consentimento</CardTitle>
              <CardDescription>
                {c.optOut
                  ? `Pediu para sair em ${fmtDateTime(c.optOutAt)}. Não recebe campanhas.`
                  : c.optIn
                    ? `Opt-in em ${fmtDateTime(c.optInAt)} (${c.optInSource ?? 'origem não informada'}).`
                    : 'Sem consentimento registrado: não recebe campanhas de marketing.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                {(!c.optIn || c.optOut) && (
                  <Button size="sm" variant="outline" onClick={() => setModal('optin')}>
                    <ShieldCheck /> Registrar opt-in
                  </Button>
                )}
                {!c.optOut && (
                  <Button size="sm" variant="outline" onClick={() => setModal('optout')}>
                    <ShieldOff /> Registrar opt-out
                  </Button>
                )}
              </div>
              {c.consentLogs.length > 0 && (
                <ol className="grid gap-2 border-l-2 pl-3">
                  {c.consentLogs.map((l) => (
                    <li key={l.id} className="text-xs">
                      <span className="font-semibold">{l.action === 'OPT_IN' ? 'Opt-in' : 'Opt-out'}</span> · {fmtDateTime(l.createdAt)}
                      <span className="block text-muted-foreground">
                        {l.source}
                        {l.detail ? ` — ${l.detail}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>LGPD</CardTitle>
              <CardDescription>Atenda pedidos do titular: cópia dos dados ou exclusão.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/contacts/${id}/export`} download>
                  <Download /> Exportar dados
                </a>
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setModal('delete')}>
                <Trash2 /> Excluir contato
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={modal !== null} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          {(modal === 'optin' || modal === 'optout') && (
            <>
              <DialogHeader>
                <DialogTitle>{modal === 'optin' ? 'Registrar opt-in' : 'Registrar opt-out'}</DialogTitle>
                <DialogDescription>
                  {modal === 'optin'
                    ? 'Registre só se o cliente autorizou de forma clara receber mensagens de marketing.'
                    : 'O contato deixa de receber campanhas imediatamente. O atendimento continua normal.'}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={(e) => consent(e, modal === 'optin' ? 'OPT_IN' : 'OPT_OUT')} className="grid gap-4">
                <Field label="Como foi o pedido?" htmlFor="source">
                  <Input id="source" name="source" required minLength={3} placeholder={modal === 'optin' ? 'ex.: autorizou no balcão' : 'ex.: pediu por telefone'} />
                </Field>
                <DialogFooter>
                  <Button type="submit">Registrar</Button>
                </DialogFooter>
              </form>
            </>
          )}
          {modal === 'delete' && (
            <>
              <DialogHeader>
                <DialogTitle>Excluir contato definitivamente</DialogTitle>
                <DialogDescription>
                  Apaga o contato, todas as conversas, mensagens, tags e o histórico de consentimento. Não dá para desfazer. Se ele escrever de novo,
                  vira um contato novo, sem opt-in.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={remove} className="grid gap-4">
                <Field label={`Para confirmar, digite o telefone ${formatPhone(c.phone)}`} htmlFor="confirmPhone">
                  <Input id="confirmPhone" name="confirmPhone" required inputMode="tel" autoComplete="off" />
                </Field>
                <DialogFooter>
                  <Button type="submit" variant="destructive">
                    <Trash2 /> Excluir tudo
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
          {modal === 'start' && (
            <TemplateSendForm
              mode="start"
              contactId={c.id}
              contactFirstName={c.name?.split(' ')[0]}
              canMarketing={c.optIn && !c.optOut}
              onSent={(convId) => {
                setModal(null);
                router.push(`/inbox?c=${convId}`);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
