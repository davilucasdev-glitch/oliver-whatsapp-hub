'use client';

import { ChevronLeft, ChevronRight, Plus, Search, Tags, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { ConsentBadge, displayName, formatPhone, TagChips } from '@/components/contact-bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import { TagPicker } from '@/components/tag-picker';
import type { ContactListItem, Tag } from '@/lib/types';
import { fmtInt, timeAgo } from '@/lib/utils';

const PAGE_SIZE = 50;

function NewContactDialog({ tags, onDone }: { tags: Tag[]; onDone: () => void }) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    try {
      await api('/contacts', {
        method: 'POST',
        body: {
          phone: f.get('phone'),
          name: f.get('name') || undefined,
          email: f.get('email') || '',
          tagIds,
          optInSource: consent ? String(f.get('source') ?? '') : undefined,
        },
      });
      toast.success('Contato cadastrado');
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
        <DialogTitle>Novo contato</DialogTitle>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="WhatsApp" htmlFor="phone">
          <Input id="phone" name="phone" required inputMode="tel" placeholder="(11) 98888-7777" />
        </Field>
        <Field label="Nome" htmlFor="name">
          <Input id="name" name="name" />
        </Field>
        <Field label="E-mail" htmlFor="email">
          <Input id="email" name="email" type="email" />
        </Field>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Tags</span>
          <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
          <span>O cliente autorizou receber mensagens de marketing</span>
        </label>
        {consent && (
          <Field label="Como autorizou?" htmlFor="source" hint="Fica registrado no histórico de consentimento (LGPD).">
            <Input id="source" name="source" required minLength={3} placeholder="ex.: pediu no balcão da loja" />
          </Field>
        )}
        <DialogFooter>
          <Button type="submit" loading={loading}>
            Salvar
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function TagsDialog({ tags, onChanged }: { tags: Tag[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/tags', { method: 'POST', body: { name } });
      setName('');
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function remove(t: Tag) {
    if (!window.confirm(`Excluir a tag "${t.name}"? Ela sai de ${t.contacts ?? 0} contato(s); os contatos continuam.`)) return;
    await api(`/tags/${t.id}`, { method: 'DELETE' }).catch((e: Error) => toast.error(e.message));
    onChanged();
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Tags</DialogTitle>
        <DialogDescription>Use tags para montar segmentos (ex.: “comprou árabe”, “VIP”, “inativo 60 dias”).</DialogDescription>
      </DialogHeader>
      <form onSubmit={add} className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova tag" maxLength={50} aria-label="Nome da nova tag" />
        <Button type="submit" disabled={!name.trim()}>
          <Plus /> Criar
        </Button>
      </form>
      <ul className="grid gap-1">
        {tags.map((t) => (
          <li key={t.id} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted">
            <span className="text-sm font-medium">
              {t.name} <span className="text-xs font-normal text-muted-foreground">· {fmtInt(t.contacts ?? 0)} contatos</span>
            </span>
            <Button variant="ghost" size="icon" onClick={() => remove(t)} aria-label={`Excluir tag ${t.name}`}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ContatosPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [consent, setConsent] = useState('any');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<'new' | 'tags' | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const key = useMemo(() => {
    const q = new URLSearchParams({ consent, page: String(page), pageSize: String(PAGE_SIZE) });
    if (debounced) q.set('search', debounced);
    if (tagFilter.length) q.set('tags', tagFilter.join(','));
    return `/contacts?${q}`;
  }, [debounced, tagFilter, consent, page]);

  const { data, mutate } = useSWR<{ total: number; contacts: ContactListItem[] }>(key, fetcher, { keepPreviousData: true });
  const { data: tagData, mutate: mutateTags } = useSWR<{ tags: Tag[] }>('/tags', fetcher);
  const tags = tagData?.tags ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title="Contatos"
        description="Clientes, tags e consentimento. Só quem tem opt-in recebe campanhas; quem pediu para sair nunca mais entra."
        actions={
          <>
            <Button variant="outline" onClick={() => setModal('tags')}>
              <Tags /> Tags
            </Button>
            <Button variant="outline" asChild>
              <Link href="/contatos/importar">
                <Upload /> Importar CSV
              </Link>
            </Button>
            <Button onClick={() => setModal('new')}>
              <Plus /> Novo contato
            </Button>
          </>
        }
      />

      <Card className="mb-4 grid gap-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, telefone ou e-mail" className="pl-9" aria-label="Buscar contatos" />
          </div>
          <Select
            value={consent}
            onChange={(e) => {
              setConsent(e.target.value);
              setPage(1);
            }}
            className="sm:w-56"
            aria-label="Filtrar por consentimento"
          >
            <option value="any">Todos os consentimentos</option>
            <option value="optIn">Com opt-in</option>
            <option value="noConsent">Sem consentimento</option>
            <option value="optOut">Pediram para sair</option>
          </Select>
        </div>
        {tags.length > 0 && (
          <TagPicker
            tags={tags}
            selected={tagFilter}
            onChange={(ids) => {
              setTagFilter(ids);
              setPage(1);
            }}
          />
        )}
      </Card>

      <p className="mb-2 text-sm text-muted-foreground">{data ? `${fmtInt(data.total)} contato(s)` : 'Carregando…'}</p>

      <Card className="overflow-hidden">
        <ul className="divide-y">
          {data?.contacts.map((c) => (
            <li key={c.id}>
              <Link href={`/contatos/${c.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 sm:w-64">
                  <span className="block truncate text-sm font-semibold">{displayName(c)}</span>
                  <span className="block text-xs text-muted-foreground">{c.name ? formatPhone(c.phone) : 'sem nome'}</span>
                </span>
                <span className="flex-1">
                  <TagChips tags={c.tags} />
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{c.lastInboundAt ? `escreveu ${timeAgo(c.lastInboundAt)}` : 'nunca escreveu'}</span>
                  <ConsentBadge c={c} />
                </span>
              </Link>
            </li>
          ))}
          {data?.contacts.length === 0 && <li className="p-8 text-center text-sm text-muted-foreground">Nenhum contato encontrado.</li>}
        </ul>
      </Card>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft /> Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {page} de {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Próxima <ChevronRight />
          </Button>
        </div>
      )}

      <Dialog open={modal !== null} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          {modal === 'new' && (
            <NewContactDialog
              tags={tags}
              onDone={() => {
                setModal(null);
                void mutate();
              }}
            />
          )}
          {modal === 'tags' && (
            <TagsDialog
              tags={tags}
              onChanged={() => {
                void mutateTags();
                void mutate();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
