'use client';

import { Bot, MoonStar, RotateCcw, Send, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Label, Switch, Textarea } from '@/components/ui/form';
import { WaText } from '@/components/wa-text';
import { api } from '@/lib/api';
import type { BotLogItem, SimSession } from '@/lib/types';
import { cn } from '@/lib/utils';
import { TokenLine, ToolChips } from './tool-chips';

const STORAGE_KEY = 'oliver.sim.session';
const SUGGESTIONS = ['Oi! Procuro um perfume doce para presente', 'Tem Lattafa em estoque?', 'Qual o status do meu pedido?', 'Quero falar com um atendente'];

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function store(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* navegador sem armazenamento: só não lembra a sessão */
  }
}

const fmtTime = (iso: string) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

export function Simulator() {
  const [session, setSession] = useState<SimSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [forceClosed, setForceClosed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // retoma a última conversa de teste deste navegador
    const id = readStored();
    (id ? api<{ session: SimSession }>(`/bot/sim/sessions/${id}`) : Promise.resolve(null))
      .then((r) => r && setSession(r.session))
      .catch(() => store(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [session?.messages.length, sending]);

  async function create(e?: React.FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const f = e ? new FormData(e.currentTarget) : null;
    try {
      const r = await api<{ session: SimSession }>('/bot/sim/sessions', {
        method: 'POST',
        body: {
          customerName: String(f?.get('customerName') ?? '') || undefined,
          phone: String(f?.get('phone') ?? '') || undefined,
          document: String(f?.get('document') ?? '') || undefined,
        },
      });
      setSession(r.session);
      store(r.session.id);
      setNewOpen(false);
      return r.session;
    } catch (err) {
      toast.error((err as Error).message);
      return null;
    }
  }

  async function send(value = text) {
    const msg = value.trim();
    if (!msg || sending) return;
    const s = session ?? (await create());
    if (!s) return;
    setText('');
    setSending(true);
    // mostra a mensagem na hora, enquanto o bot pensa
    setSession({ ...s, messages: [...s.messages, { role: 'user', text: msg, at: new Date().toISOString() }] });
    try {
      const r = await api<{ session: SimSession }>(`/bot/sim/sessions/${s.id}/messages`, { method: 'POST', body: { text: msg, forceClosed } });
      setSession(r.session);
    } catch (err) {
      toast.error((err as Error).message);
      setSession(s);
      setText(msg);
    } finally {
      setSending(false);
    }
  }

  async function release() {
    if (!session) return;
    const r = await api<{ session: SimSession }>(`/bot/sim/sessions/${session.id}/release`, { method: 'POST' });
    setSession(r.session);
  }

  // Cada resposta do bot ganha o registro (ferramentas e tokens) logo abaixo.
  // O registro é gravado logo depois da última mensagem da resposta: liga cada um à mensagem anterior a ele.
  const logsByReply = new Map<number, BotLogItem>();
  if (session) {
    for (const log of session.logs) {
      const t = Date.parse(log.createdAt);
      let idx = -1;
      session.messages.forEach((m, i) => {
        if (m.role !== 'user' && Date.parse(m.at) <= t) idx = i;
      });
      if (idx >= 0) logsByReply.set(idx, log);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <Card className="flex h-[min(72dvh,720px)] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{session?.customerName ?? 'Cliente de teste'}</p>
            <p className="truncate text-xs text-muted-foreground">
              {session ? `${session.phone}${session.document ? ' · com CPF' : ''}` : 'Nada aqui vai para o WhatsApp'}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
            <RotateCcw /> Nova conversa
          </Button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto bg-[oklch(0.95_0.015_150)] px-3 py-4 sm:px-5" aria-live="polite">
          {loading && <p className="text-center text-sm text-muted-foreground">Carregando…</p>}
          {!loading && !session?.messages.length && (
            <div className="mx-auto grid max-w-sm gap-2 pt-8 text-center">
              <Bot className="mx-auto size-8 text-primary" />
              <p className="text-sm font-semibold">Converse com o bot como se fosse um cliente</p>
              <p className="text-xs text-muted-foreground">Ele usa o catálogo, a base de conhecimento e as regras de verdade. Experimente:</p>
              <div className="mt-2 grid gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s)} className="cursor-pointer rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-muted">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {session?.messages.map((m, i) => {
            const log = logsByReply.get(i);
            if (m.role === 'system') {
              return (
                <p key={i} className="mx-auto w-fit max-w-[90%] rounded-md bg-warning-soft px-3 py-1.5 text-center text-xs font-medium text-[oklch(0.45_0.11_60)]">
                  {m.text}
                </p>
              );
            }
            const mine = m.role === 'user';
            return (
              <div key={i} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                <div
                  className={cn(
                    'max-w-[85%] rounded-lg px-3 py-2 text-[14px] leading-relaxed shadow-sm sm:max-w-[70%]',
                    mine ? 'rounded-tr-none bg-[oklch(0.9_0.07_150)]' : 'rounded-tl-none bg-white',
                  )}
                >
                  {m.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- foto do produto (link do Bling)
                    <img src={m.imageUrl} alt={m.text} className="mb-1 max-h-60 rounded-md object-cover" />
                  )}
                  <WaText text={m.text} />
                  <span className="mt-0.5 block text-right text-[10px] text-muted-foreground">{fmtTime(m.at)}</span>
                </div>
                {log && (
                  <div className="mt-1 grid max-w-[85%] gap-1 px-1 sm:max-w-[70%]">
                    {log.toolsCalled.length > 0 && <ToolChips log={log} />}
                    <TokenLine log={log} />
                    {log.error && <span className="text-[11px] text-destructive">{log.error}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {sending && (
            <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:120ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:240ms]" />
              <span className="ml-1">o bot está respondendo…</span>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {session?.handedOff ? (
          <div className="flex flex-col gap-2 border-t bg-warning-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              <UserRound className="mr-1 inline size-4" />
              Transferida para atendente{session.handoffReason ? `: ${session.handoffReason}` : ''}. No WhatsApp o bot pararia de responder aqui.
            </p>
            <Button size="sm" variant="outline" onClick={() => void release()}>
              Devolver ao bot
            </Button>
          </div>
        ) : (
          <form
            className="flex items-end gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Escreva como se fosse o cliente…"
              className="max-h-32 min-h-10 resize-none py-2"
              aria-label="Mensagem do cliente"
            />
            <Button type="submit" size="icon" className="shrink-0" loading={sending} aria-label="Enviar">
              <Send />
            </Button>
          </form>
        )}
      </Card>

      <div className="grid content-start gap-4">
        <Card className="grid gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="closed" className="flex items-center gap-2">
              <MoonStar className="size-4" /> Simular fora do horário
            </Label>
            <Switch id="closed" checked={forceClosed} onCheckedChange={setForceClosed} />
          </div>
          <p className="text-xs text-muted-foreground">Para ver como o bot responde quando a equipe não está atendendo.</p>
        </Card>
        <Card className="grid gap-2 p-4 text-sm">
          <p className="font-semibold">Como testar</p>
          <ul className="grid gap-1.5 text-xs text-muted-foreground">
            <li>• Abaixo de cada resposta aparecem as ferramentas usadas (passe o mouse para ver o que buscou) e os tokens.</li>
            <li>• Pedidos: em “Nova conversa”, use o telefone ou o CPF de um cliente real do Bling.</li>
            <li>• Mudou a base de conhecimento? A próxima mensagem já usa o texto novo.</li>
            <li>• Tudo fica registrado em “Registros”, marcado como simulador.</li>
          </ul>
        </Card>
        {session?.summary && (
          <Card className="grid gap-1 p-4">
            <p className="text-sm font-semibold">Resumo guardado</p>
            <p className="whitespace-pre-line text-xs text-muted-foreground">{session.summary}</p>
          </Card>
        )}
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <form onSubmit={(e) => void create(e)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Nova conversa de teste</DialogTitle>
              <DialogDescription>O telefone e o CPF são usados só para o bot consultar pedidos no Bling.</DialogDescription>
            </DialogHeader>
            <Field label="Nome do cliente (opcional)" htmlFor="customerName">
              <Input id="customerName" name="customerName" placeholder="Maria" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Telefone (opcional)" htmlFor="phone">
                <Input id="phone" name="phone" inputMode="tel" placeholder="(11) 98888-7777" />
              </Field>
              <Field label="CPF/CNPJ (opcional)" htmlFor="document">
                <Input id="document" name="document" inputMode="numeric" />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit">Começar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
