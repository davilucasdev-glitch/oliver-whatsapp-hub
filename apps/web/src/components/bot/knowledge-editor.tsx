'use client';

import { FileDown, Save, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { KnowledgeInfo } from '@/lib/types';
import { fmtDateTime, fmtInt } from '@/lib/utils';

export function KnowledgeEditor() {
  const { data, mutate } = useSWR<KnowledgeInfo>('/bot/knowledge', fetcher, { revalidateOnFocus: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const content = draft ?? data.content;
  const dirty = draft !== null && draft !== data.content;
  const pendingNow = content.split('\n').filter((l) => l.includes('[DEFINIR')).length;

  async function save() {
    setSaving(true);
    try {
      await api('/bot/knowledge', { method: 'PUT', body: { content, note: note || undefined } });
      toast.success('Base de conhecimento salva. A próxima resposta do bot já usa o texto novo.');
      setDraft(null);
      setNote('');
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function loadVersion(id: string) {
    try {
      const r = await api<{ version: { content: string; createdAt: string } }>(`/bot/knowledge/versions/${id}`);
      setDraft(r.version.content);
      toast.info(`Versão de ${fmtDateTime(r.version.createdAt)} carregada no editor. Salve para voltar a ela.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function restoreFile() {
    try {
      await api('/bot/knowledge/restore-file', { method: 'POST' });
      toast.success('Conteúdo do arquivo knowledge/oliver.md restaurado.');
      setConfirmRestore(false);
      setDraft(null);
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {data.source === 'painel' ? `Editada pelo painel em ${fmtDateTime(data.updatedAt)}` : 'Conteúdo do arquivo knowledge/oliver.md (ainda não editado aqui)'}
          </p>
          <span className={content.length > data.maxChars ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {fmtInt(content.length)} / {fmtInt(data.maxChars)} caracteres
          </span>
        </div>
        <Textarea
          value={content}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck
          className="min-h-[60dvh] font-mono text-[13px] leading-relaxed"
          aria-label="Base de conhecimento"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="O que mudou? (opcional, aparece no histórico)" maxLength={200} />
          <div className="flex shrink-0 gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Descartar
              </Button>
            )}
            <Button onClick={() => void save()} loading={saving} disabled={!dirty && data.source === 'painel'}>
              <Save /> Salvar
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Falta definir <Badge tone={pendingNow ? 'warning' : 'success'}>{pendingNow}</Badge>
            </CardTitle>
            <CardDescription>Enquanto um item estiver como [DEFINIR], o bot não inventa: passa para um atendente quando o cliente precisar dele.</CardDescription>
          </CardHeader>
          {data.pending.length > 0 && (
            <CardContent>
              <ul className="grid gap-1.5 text-xs">
                {data.pending.map((p, i) => (
                  <li key={i} className="flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[oklch(0.6_0.13_60)]" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Histórico</CardTitle>
            <CardDescription>As 30 últimas versões salvas.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1.5">
            {data.versions.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma edição ainda.</p>}
            {data.versions.map((v, i) => (
              <button
                key={v.id}
                onClick={() => void loadVersion(v.id)}
                className="cursor-pointer rounded-md border px-2.5 py-2 text-left text-xs hover:bg-muted"
              >
                <span className="font-medium">{fmtDateTime(v.createdAt)}</span>
                {i === 0 && <Badge className="ml-1.5">atual</Badge>}
                {v.note && <span className="mt-0.5 block text-muted-foreground">{v.note}</span>}
              </button>
            ))}
            <Button variant="outline" size="sm" className="mt-2 justify-self-start" onClick={() => setConfirmRestore(true)}>
              <FileDown /> Restaurar do arquivo
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restaurar do arquivo?</DialogTitle>
            <DialogDescription>
              O texto do arquivo knowledge/oliver.md vira a versão atual. A versão de agora continua no histórico, então dá para voltar a ela.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestore(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void restoreFile()}>Restaurar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
