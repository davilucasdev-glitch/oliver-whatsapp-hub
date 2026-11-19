'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { WhatsAppBubble } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { PhoneNumber, Template } from '@/lib/types';

/**
 * Escolher template aprovado + preencher variáveis. Usado para responder fora da janela de 24h
 * (inbox) e para iniciar conversa com um contato (ficha do contato).
 */
export function TemplateSendForm({
  mode,
  conversationId,
  contactId,
  contactFirstName,
  wabaId,
  canMarketing,
  onSent,
}: {
  mode: 'conversation' | 'start';
  conversationId?: string;
  contactId?: string;
  contactFirstName?: string;
  wabaId?: string;
  canMarketing: boolean;
  onSent: (conversationId?: string) => void;
}) {
  const { data: tpls } = useSWR<{ templates: Template[] }>('/templates?status=APPROVED', fetcher);
  const { data: nums } = useSWR<{ numbers: PhoneNumber[] }>(mode === 'start' ? '/numbers' : null, fetcher);
  const [numberId, setNumberId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [body, setBody] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const activeNumbers = nums?.numbers.filter((n) => n.isActive) ?? [];
  const selectedNumber = activeNumbers.find((n) => n.id === numberId) ?? activeNumbers[0];
  const waba = wabaId ?? selectedNumber?.wabaId;
  const options = (tpls?.templates ?? []).filter((t) => (!waba || t.wabaId === waba) && (canMarketing || t.category !== 'MARKETING'));
  const tpl = options.find((t) => t.id === templateId);
  const blockedMarketing = (tpls?.templates ?? []).some((t) => t.category === 'MARKETING') && !canMarketing;

  function pick(id: string) {
    setTemplateId(id);
    const t = options.find((x) => x.id === id);
    setHeader(Array.from({ length: t?.variables.header ?? 0 }, () => ''));
    // {{1}} costuma ser o nome do cliente
    setBody(Array.from({ length: t?.variables.body ?? 0 }, (_, i) => (i === 0 && contactFirstName ? contactFirstName : '')));
  }

  const preview = tpl?.preview ?? '';

  async function send() {
    if (!tpl) return toast.error('Escolha um template.');
    setSending(true);
    try {
      if (mode === 'conversation') {
        await api(`/conversations/${conversationId}/template`, { method: 'POST', body: { templateId: tpl.id, header, body } });
        toast.success('Template enviado');
        onSent(conversationId);
      } else {
        const r = await api<{ conversationId: string }>(`/contacts/${contactId}/start-conversation`, {
          method: 'POST',
          body: { numberId: selectedNumber?.id, templateId: tpl.id, header, body },
        });
        toast.success('Conversa iniciada');
        onSent(r.conversationId);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === 'start' ? 'Iniciar conversa' : 'Enviar template'}</DialogTitle>
        <DialogDescription>
          Fora da janela de 24h a Meta só permite mensagens de template aprovado.
          {blockedMarketing && ' Templates de marketing aparecem só para contatos com opt-in.'}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        {mode === 'start' && (
          <Field label="Enviar pelo número" htmlFor="tpl-number">
            <Select id="tpl-number" value={selectedNumber?.id ?? ''} onChange={(e) => setNumberId(e.target.value)}>
              {activeNumbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.displayName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Template" htmlFor="tpl-id">
          <Select id="tpl-id" value={templateId} onChange={(e) => pick(e.target.value)}>
            <option value="">Escolha…</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.category === 'MARKETING' ? 'marketing' : 'utilidade'}, {t.language})
              </option>
            ))}
          </Select>
        </Field>
        {header.map((v, i) => (
          <Field key={`h${i}`} label={`Cabeçalho {{${i + 1}}}`} htmlFor={`tpl-h${i}`}>
            <Input id={`tpl-h${i}`} value={v} onChange={(e) => setHeader((o) => Object.assign([...o], { [i]: e.target.value }))} />
          </Field>
        ))}
        {body.map((v, i) => (
          <Field key={`b${i}`} label={`Variável {{${i + 1}}}`} htmlFor={`tpl-b${i}`}>
            <Input id={`tpl-b${i}`} value={v} onChange={(e) => setBody((o) => Object.assign([...o], { [i]: e.target.value }))} />
          </Field>
        ))}
        {tpl && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Modelo (com os exemplos cadastrados na Meta)</p>
            <WhatsAppBubble text={preview} />
          </div>
        )}
        {options.length === 0 && tpls && (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Nenhum template aprovado disponível. Sincronize ou crie um em Templates.</p>
        )}
      </div>
      <DialogFooter>
        <Button onClick={send} loading={sending} disabled={!tpl}>
          <Send /> Enviar
        </Button>
      </DialogFooter>
    </>
  );
}
