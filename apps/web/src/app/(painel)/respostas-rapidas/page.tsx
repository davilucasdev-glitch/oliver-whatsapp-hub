'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { QuickReply } from '@/lib/types';

export default function RespostasRapidasPage() {
  const { data, mutate } = useSWR<{ quickReplies: QuickReply[] }>('/quick-replies', fetcher);
  const [editing, setEditing] = useState<QuickReply | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { shortcut: f.get('shortcut'), title: f.get('title'), body: f.get('body') };
    setSaving(true);
    try {
      if (editing === 'new') await api('/quick-replies', { method: 'POST', body });
      else if (editing) await api(`/quick-replies/${editing.id}`, { method: 'PATCH', body });
      toast.success('Resposta salva');
      setEditing(null);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(q: QuickReply) {
    if (!window.confirm(`Excluir a resposta ${q.shortcut}?`)) return;
    await api(`/quick-replies/${q.id}`, { method: 'DELETE' }).catch((e: Error) => toast.error(e.message));
    await mutate();
  }

  const current = editing && editing !== 'new' ? editing : null;

  return (
    <>
      <PageHeader
        title="Respostas rápidas"
        description="Na inbox, digite / e o atalho (ex.: /pix) para inserir a resposta. Use {nome} para o primeiro nome do cliente."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> Nova resposta
          </Button>
        }
      />
      <div className="grid gap-3 md:grid-cols-2">
        {data?.quickReplies.map((q) => (
          <Card key={q.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-sm font-semibold text-primary">{q.shortcut}</p>
                <p className="text-sm font-medium">{q.title}</p>
              </div>
              <div className="flex">
                <Button variant="ghost" size="icon" onClick={() => setEditing(q)} aria-label={`Editar ${q.shortcut}`}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => remove(q)} aria-label={`Excluir ${q.shortcut}`}>
                  <Trash2 />
                </Button>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{q.body}</p>
          </Card>
        ))}
        {data?.quickReplies.length === 0 && (
          <Card className="border-dashed p-8 text-center text-sm text-muted-foreground md:col-span-2">Nenhuma resposta rápida ainda.</Card>
        )}
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{current ? `Editar ${current.shortcut}` : 'Nova resposta rápida'}</DialogTitle>
            <DialogDescription>Sugestões: /pix, /frete, /prazo, /troca, /horario.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-4" key={current?.id ?? 'new'}>
            <Field label="Atalho" htmlFor="shortcut">
              <Input id="shortcut" name="shortcut" required defaultValue={current?.shortcut ?? '/'} />
            </Field>
            <Field label="Título" htmlFor="title">
              <Input id="title" name="title" required defaultValue={current?.title ?? ''} />
            </Field>
            <Field label="Texto" htmlFor="body">
              <Textarea id="body" name="body" required rows={6} defaultValue={current?.body ?? ''} />
            </Field>
            <DialogFooter>
              <Button type="submit" loading={saving}>
                Salvar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
