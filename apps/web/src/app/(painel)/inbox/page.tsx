'use client';

import { AlertCircle, ArrowLeft, Bot, Check, CheckCheck, Clock, FileText, Hand, IdCard, Loader2, Paperclip, Search, Send, UserRound, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { ConsentBadge, displayName, formatPhone } from '@/components/contact-bits';
import { TemplateSendForm } from '@/components/template-send';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CustomerPanel } from '@/components/customer-panel';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/form';
import { api, ApiError, fetcher } from '@/lib/api';
import type { Assignee, ChatMessage, ConversationDetail, ConversationList, ConversationListItem, QuickReply } from '@/lib/types';
import { cn } from '@/lib/utils';

const FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'mine', label: 'Minhas' },
  { key: 'awaiting', label: 'Aguardando' },
  { key: 'unread', label: 'Não lidas' },
  { key: 'bot', label: 'Com bot' },
  { key: 'human', label: 'Com humano' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const SENDER_LABEL: Record<string, string> = {
  BOT: 'Bot',
  HUMAN: 'Atendente',
  SYSTEM: 'Sistema',
  CAMPAIGN: 'Campanha',
};

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat('pt-BR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' }).format(d);
}

function preview(m: ConversationListItem['lastMessage']): string {
  if (!m) return '';
  const media: Record<string, string> = {
    image: '📷 Foto',
    audio: '🎤 Áudio',
    video: '🎬 Vídeo',
    document: '📄 Documento',
    sticker: 'Figurinha',
    template: '📋 Template',
  };
  const text = m.body || media[m.type] || m.type;
  return m.direction === 'OUTBOUND' ? `${SENDER_LABEL[m.sentBy] ?? 'Você'}: ${text}` : text;
}

function HandlerBadge({ h }: { h: 'BOT' | 'HUMAN' }) {
  return h === 'BOT' ? (
    <Badge tone="brand">
      <Bot className="size-3" /> Bot
    </Badge>
  ) : (
    <Badge tone="warning">
      <UserRound className="size-3" /> Humano
    </Badge>
  );
}

function StatusIcon({ m }: { m: ChatMessage }) {
  if (m.direction === 'INBOUND') return null;
  if (m.status === 'FAILED') return <AlertCircle className="size-3.5 text-destructive" aria-label="Falhou" />;
  if (m.status === 'READ') return <CheckCheck className="size-3.5 text-[oklch(0.6_0.14_235)]" aria-label="Lida" />;
  if (m.status === 'DELIVERED') return <CheckCheck className="size-3.5" aria-label="Entregue" />;
  if (m.status === 'SENT') return <Check className="size-3.5" aria-label="Enviada" />;
  return <Clock className="size-3" aria-label="Enviando" />;
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const out = m.direction === 'OUTBOUND';
  const src = m.mediaId ? `/api/media/${m.id}` : null;
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-xl px-3 py-2 text-[14.5px] leading-relaxed shadow-sm sm:max-w-[70%]',
          out ? 'rounded-tr-sm bg-[oklch(0.93_0.04_335)]' : 'rounded-tl-sm bg-card',
          m.status === 'FAILED' && 'ring-1 ring-destructive/40',
        )}
      >
        {out && (m.sentBy !== 'HUMAN' || m.sentByName) && (
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary/70">
            {m.sentBy === 'HUMAN' ? m.sentByName : SENDER_LABEL[m.sentBy]}
          </p>
        )}
        {m.type === 'template' && <p className="mb-1 text-[11px] font-medium text-muted-foreground">Template {m.templateName}</p>}
        {src && m.type === 'image' && (
          <a href={src} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element -- mídia autenticada servida pela API */}
            <img src={src} alt={m.body ?? 'Imagem'} className="mb-1 max-h-72 rounded-lg object-cover" loading="lazy" />
          </a>
        )}
        {src && m.type === 'sticker' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="Figurinha" className="size-28" loading="lazy" />
        )}
        {src && m.type === 'audio' && <audio controls src={src} className="max-w-full" preload="none" />}
        {src && m.type === 'video' && <video controls src={src} className="mb-1 max-h-72 rounded-lg" preload="none" />}
        {src && m.type === 'document' && (
          <a href={src} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-2.5 py-2 text-sm font-medium">
            <FileText className="size-4" /> {m.filename ?? 'Documento'}
          </a>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {!m.body && !src && <p className="italic text-muted-foreground">[{m.type}]</p>}
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {shortTime(m.createdAt)} <StatusIcon m={m} />
        </p>
        {m.status === 'FAILED' && m.errorMessage && <p className="mt-1 text-xs text-destructive">Não entregue: {m.errorMessage}</p>}
      </div>
    </div>
  );
}

function ConversationRow({ c, active, onClick }: { c: ConversationListItem; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn('flex w-full cursor-pointer gap-3 border-b px-4 py-3 text-left transition-colors', active ? 'bg-secondary' : 'hover:bg-muted/70')}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[oklch(0.9_0.03_75)] text-sm font-semibold text-[oklch(0.35_0.06_60)]">
        {(c.contact.name?.[0] ?? '#').toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={cn('truncate text-sm', c.unreadCount ? 'font-bold' : 'font-semibold')}>{displayName(c.contact)}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{shortTime(c.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn('truncate text-[13px]', c.unreadCount ? 'text-foreground' : 'text-muted-foreground')}>{preview(c.lastMessage)}</span>
          {c.unreadCount > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-success px-1.5 text-[11px] font-bold text-white">{c.unreadCount}</span>
          )}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {c.handler === 'BOT' ? <Bot className="size-3" /> : <UserRound className="size-3" />}
          {c.handler === 'BOT' ? 'Bot' : (c.assignedTo?.name ?? 'Humano')} · {c.phoneNumber.displayName}
          {!c.windowOpen && <span className="text-[oklch(0.5_0.1_60)]">· janela fechada</span>}
        </span>
      </span>
    </button>
  );
}

function Composer({ conv, onSent }: { conv: ConversationDetail; onSent: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: qr } = useSWR<{ quickReplies: QuickReply[] }>('/quick-replies', fetcher);

  const slash = text.startsWith('/') && !text.includes(' ') && !text.includes('\n');
  const suggestions = slash ? (qr?.quickReplies ?? []).filter((q) => q.shortcut.startsWith(text.toLowerCase())).slice(0, 6) : [];

  async function sendText() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api(`/conversations/${conv.id}/messages`, {
        method: 'POST',
        body: { text: body },
      });
      setText('');
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    setSending(true);
    try {
      const form = new FormData();
      if (text.trim()) form.append('caption', text.trim());
      form.append('file', file);
      const res = await fetch(`/api/conversations/${conv.id}/media`, {
        method: 'POST',
        body: form,
        headers: { 'x-oliver-panel': '1' },
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Erro ${res.status}`);
      setText('');
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const firstName = conv.contact.name?.split(' ')[0];
  const canMarketing = conv.contact.optIn && !conv.contact.optOut;

  if (!conv.windowOpen) {
    return (
      <div className="border-t bg-warning-soft/70 px-4 py-3">
        <p className="text-sm">
          <strong>Janela de 24h fechada.</strong> O cliente não escreve há mais de 24h; só é possível enviar um template aprovado.
        </p>
        <Button className="mt-2" size="sm" onClick={() => setTplOpen(true)}>
          <FileText /> Enviar template
        </Button>
        <Dialog open={tplOpen} onOpenChange={setTplOpen}>
          <DialogContent>
            <TemplateSendForm
              mode="conversation"
              conversationId={conv.id}
              wabaId={conv.phoneNumber.wabaId}
              contactFirstName={firstName}
              canMarketing={canMarketing}
              onSent={() => {
                setTplOpen(false);
                onSent();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="relative border-t bg-card px-3 py-2.5">
      {suggestions.length > 0 && (
        <div className="absolute inset-x-3 bottom-full mb-1 overflow-hidden rounded-lg border bg-card shadow-lg">
          {suggestions.map((q) => (
            <button
              key={q.id}
              onClick={() => setText(q.body.replaceAll('{nome}', firstName ?? ''))}
              className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span className="font-mono text-xs font-semibold text-primary">{q.shortcut}</span>
              <span className="truncate text-muted-foreground">{q.title}</span>
            </button>
          ))}
        </div>
      )}
      {conv.handler === 'BOT' && (
        <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Hand className="size-3.5" /> Ao enviar, você assume a conversa e o bot para de responder este cliente.
        </p>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/jpeg,image/png,application/pdf,video/mp4,audio/*,.doc,.docx,.xls,.xlsx,.txt"
          onChange={(e) => e.target.files?.[0] && sendFile(e.target.files[0])}
        />
        <Button variant="ghost" size="icon" onClick={() => fileRef.current?.click()} disabled={sending} aria-label="Anexar foto ou arquivo">
          <Paperclip />
        </Button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (suggestions[0] && slash) setText(suggestions[0].body.replaceAll('{nome}', firstName ?? ''));
              else void sendText();
            }
          }}
          rows={1}
          placeholder="Mensagem (digite / para respostas rápidas)"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [field-sizing:content]"
          aria-label="Mensagem"
        />
        <Button size="icon" onClick={sendText} disabled={!text.trim() || sending} aria-label="Enviar">
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
    </div>
  );
}

function AssigneePicker({ conv, onChanged }: { conv: ConversationDetail; onChanged: () => void }) {
  const { data } = useSWR<{ members: Assignee[] }>('/team/members', fetcher);
  const [busy, setBusy] = useState(false);
  const members = data?.members ?? [];
  // quem já foi desativado continua aparecendo até trocar
  const options = conv.assignedTo && !members.some((m) => m.id === conv.assignedTo!.id) ? [...members, conv.assignedTo] : members;

  async function change(userId: string) {
    setBusy(true);
    try {
      await api(`/conversations/${conv.id}/assign`, {
        method: 'POST',
        body: { userId: userId || null },
      });
      toast.success(userId ? `Conversa com ${options.find((m) => m.id === userId)?.name}` : 'Conversa sem responsável');
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Select
      value={conv.assignedTo?.id ?? ''}
      onChange={(e) => void change(e.target.value)}
      disabled={busy || !data}
      aria-label="Responsável pela conversa"
      title="Responsável pela conversa"
      className="h-8 w-auto max-w-44 py-0 text-xs font-medium"
    >
      <option value="">Sem responsável</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}

function ChatPanel({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { data: conv, mutate: mutateConv } = useSWR<{
    conversation: ConversationDetail;
  }>(`/conversations/${id}`, fetcher, { refreshInterval: 10_000 });
  const { data: msgs, mutate: mutateMsgs } = useSWR<{
    messages: ChatMessage[];
    hasMore: boolean;
  }>(`/conversations/${id}/messages`, fetcher, {
    refreshInterval: 3_000,
  });
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastId = msgs?.messages.at(-1)?.id;
  const [customerOpen, setCustomerOpen] = useState(false);

  useEffect(() => {
    void api(`/conversations/${id}/read`, { method: 'POST' })
      .then(onChanged)
      .catch(() => undefined);
  }, [id, lastId, onChanged]);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lastId]);

  async function toggleHandler() {
    if (!conv) return;
    setBusy(true);
    try {
      const human = conv.conversation.handler === 'HUMAN';
      await api(`/conversations/${id}/${human ? 'release' : 'assume'}`, {
        method: 'POST',
      });
      toast.success(human ? 'Conversa devolvida ao bot' : 'Você assumiu a conversa: o bot está pausado para este cliente');
      await mutateConv();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!conv) return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Carregando…</div>;
  const c = conv.conversation;
  const assigned = () => {
    void mutateConv();
    onChanged();
  };

  const customerButton = (
    <Button size="sm" variant="outline" onClick={() => setCustomerOpen(true)} className="2xl:hidden" aria-label="Ver dados da cliente no Bling">
      <IdCard /> Cliente
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b bg-card px-3 py-2.5 sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={onBack} aria-label="Voltar para a lista">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <Link href={`/contatos/${c.contact.id}`} className="block truncate text-[15px] font-semibold hover:underline">
              {displayName(c.contact)}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {formatPhone(c.contact.phone)} · via {c.phoneNumber.displayName}
            </p>
          </div>
          <div className="hidden items-center gap-1.5 2xl:flex">
            <ConsentBadge c={c.contact} />
            <HandlerBadge h={c.handler} />
          </div>
          <div className="hidden sm:block">
            <AssigneePicker conv={c} onChanged={assigned} />
          </div>
          <div className="hidden sm:block">{customerButton}</div>
          <Button size="sm" variant={c.handler === 'HUMAN' ? 'outline' : 'default'} onClick={toggleHandler} loading={busy}>
            {c.handler === 'HUMAN' ? (
              <>
                <Bot /> Devolver ao bot
              </>
            ) : (
              <>
                <Hand /> Assumir
              </>
            )}
          </Button>
        </header>
        <div className="flex items-center gap-2 border-b bg-card px-4 py-1.5 text-xs text-muted-foreground sm:hidden">
          Responsável: <AssigneePicker conv={c} onChanged={assigned} />
          <span className="ml-auto">{customerButton}</span>
        </div>
        {c.handler === 'HUMAN' && c.handoffReason && <p className="border-b bg-warning-soft/60 px-4 py-1.5 text-xs">Com humano: {c.handoffReason}</p>}
        <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[oklch(0.96_0.008_75)] px-3 py-4 sm:px-6">
          {msgs?.hasMore && <p className="text-center text-xs text-muted-foreground">Mostrando as 50 mensagens mais recentes.</p>}
          {msgs?.messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
        </div>
        <Composer
          conv={c}
          onSent={() => {
            void mutateMsgs();
            void mutateConv();
            onChanged();
          }}
        />
      </div>
      <aside className="hidden w-80 shrink-0 border-l 2xl:flex" aria-label="Dados da cliente">
        <CustomerPanel conversationId={id} className="flex-1" />
      </aside>
      <Dialog open={customerOpen} onOpenChange={setCustomerOpen}>
        <DialogContent className="p-0 sm:max-w-md">
          <DialogTitle className="sr-only">Dados da cliente</DialogTitle>
          <CustomerPanel conversationId={id} className="max-h-[85dvh] rounded-2xl" inDialog />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InboxInner() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('c');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const key = useMemo(() => {
    const q = new URLSearchParams({ filter });
    if (debounced) q.set('search', debounced);
    return `/conversations?${q}`;
  }, [filter, debounced]);
  const { data, mutate } = useSWR<ConversationList>(key, fetcher, {
    refreshInterval: 5_000,
  });

  const refresh = useCallback(() => void mutate(), [mutate]);
  const select = (id: string | null) => router.replace(id ? `/inbox?c=${id}` : '/inbox', { scroll: false });
  const counts = data?.counts;

  return (
    <div className="flex h-[calc(100dvh-57px-61px)] overflow-hidden lg:h-dvh">
      <aside className={cn('flex w-full flex-col border-r bg-card lg:w-[360px] lg:shrink-0', selected && 'hidden lg:flex')}>
        <div className="border-b px-4 pb-3 pt-4">
          <div className="flex items-baseline justify-between">
            <h1 className="font-display text-xl font-semibold">Inbox</h1>
            <Link href="/respostas-rapidas" className="flex items-center gap-1 text-xs font-medium text-primary">
              <Zap className="size-3.5" /> Respostas rápidas
            </Link>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome ou telefone"
              className="pl-9"
              aria-label="Buscar conversa"
            />
          </div>
          <div className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {FILTERS.map((f) => {
              const n = f.key === 'all' ? undefined : counts?.[f.key];
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'cursor-pointer whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                    filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                  )}
                >
                  {f.label}
                  {n ? ` · ${n}` : ''}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!data && <p className="p-6 text-center text-sm text-muted-foreground">Carregando…</p>}
          {data?.conversations.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {debounced || filter !== 'all' ? 'Nenhuma conversa neste filtro.' : 'Nenhuma conversa ainda. Quando um cliente escrever, ela aparece aqui.'}
            </p>
          )}
          {data?.conversations.map((c) => (
            <ConversationRow key={c.id} c={c} active={c.id === selected} onClick={() => select(c.id)} />
          ))}
        </div>
      </aside>

      <section className={cn('min-w-0 flex-1 flex-col', selected ? 'flex' : 'hidden lg:flex')}>
        {selected ? (
          <ChatPanel key={selected} id={selected} onBack={() => select(null)} onChanged={refresh} />
        ) : (
          <div className="grid flex-1 place-items-center bg-[oklch(0.96_0.008_75)] p-8 text-center">
            <div>
              <p className="font-display text-lg font-semibold">Escolha uma conversa</p>
              <p className="mt-1 text-sm text-muted-foreground">As mensagens atualizam sozinhas a cada poucos segundos.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxInner />
    </Suspense>
  );
}
