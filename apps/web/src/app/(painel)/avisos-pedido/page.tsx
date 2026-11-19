'use client';

import { AlertTriangle, CheckCircle2, FileText, FlaskConical, RefreshCw, Save, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import { cn, fmtDateTime, timeAgo } from '@/lib/utils';

type Kind = 'RECEBIDO' | 'SEPARANDO' | 'PRONTO_RETIRAR' | 'ENVIADO' | 'ENTREGUE' | 'CANCELADO';
type Group = 'ABERTO' | 'SEPARANDO' | 'ETIQUETA' | 'ENVIADO' | 'ATENDIDO' | 'CANCELADO';

interface Config {
  enabled: boolean;
  testPhone: string | null;
  excludedStores: string[];
  onlyAfterFlow: boolean;
  storeInfo: string;
  trackingUrl: string;
  phoneNumberId: string | null;
  situations: Record<Group, number[]>;
  kinds: Record<Kind, { enabled: boolean; template: string }>;
  saved: boolean;
}

interface Data {
  config: Config;
  state: { cursor: string | null; baselineAt: string | null; lastRunAt: string | null; lastError: string | null; lastSummary: { seen: number; sent: number; skipped: number; failed: number } | null };
  blingConnected: boolean;
  situations: { id: number; nome: string }[];
  situationsError: string | null;
  groups: { key: Group; label: string }[];
  kinds: { key: Kind; label: string; when: string; vars: string[]; suggested: { name: string; body: string } }[];
  templates: { id: string; name: string; status: string; category: string; rejectedReason: string | null }[];
  numbers: { id: string; displayName: string; displayPhone: string | null; role: string }[];
  stores: { id: string; orders: number; tiktok: boolean }[];
  tiktokStoreId: string;
}

interface Notice {
  id: string;
  orderNumber: number;
  kind: Kind;
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  reason: string | null;
  customerName: string | null;
  phone: string | null;
  sentTo: string | null;
  templateName: string | null;
  conversationId: string | null;
  updatedAt: string;
}

const STATUS: Record<Notice['status'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  SENT: { label: 'Enviado', tone: 'success' },
  SKIPPED: { label: 'Não enviado', tone: 'warning' },
  FAILED: { label: 'Falhou', tone: 'danger' },
};

const TEMPLATE_STATUS: Record<string, string> = { APPROVED: 'aprovado', PENDING: 'em análise na Meta', REJECTED: 'recusado', PAUSED: 'pausado', DISABLED: 'desativado' };

function TestDialog({ kind, label, onClose }: { kind: Kind | null; label: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const n = new FormData(e.currentTarget).get('orderNumber');
    setBusy(true);
    try {
      const r = await api<{ sentTo: string; variables: string[]; customerPhone: string | null }>('/order-notices/test', { method: 'POST', body: { kind, orderNumber: n } });
      toast.success(`Enviado para ${r.sentTo} com: ${r.variables.join(' · ')}`, {
        description: r.customerPhone ? `De verdade iria para ${r.customerPhone}.` : 'Atenção: esse pedido não tem telefone da cliente.',
        duration: 9000,
      });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(kind)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Testar “{label}”</DialogTitle>
          <DialogDescription>Usa os dados de um pedido real do Bling e manda só para o número de teste. A cliente não recebe nada e o aviso de verdade continua valendo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Nº do pedido no Bling" htmlFor="t-num">
            <Input id="t-num" name="orderNumber" inputMode="numeric" required autoFocus placeholder="Ex.: 8825" className="w-40" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={busy}>
              <Send /> Enviar teste
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function History() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = new URLSearchParams({ take: '60', ...(status ? { status } : {}), ...(search.trim() ? { search: search.trim() } : {}) });
  const { data } = useSWR<{ notices: Notice[]; last7days: Record<string, number> }>(`/order-notices/log?${q}`, fetcher, { refreshInterval: 15_000 });
  const kinds: Record<Kind, string> = {
    RECEBIDO: 'Recebemos seu pedido',
    SEPARANDO: 'Separando',
    PRONTO_RETIRAR: 'Pronto para retirar',
    ENVIADO: 'Saiu para entrega',
    ENTREGUE: 'Entregue',
    CANCELADO: 'Cancelado',
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Histórico</CardTitle>
        <CardDescription>
          Últimos 7 dias: {data?.last7days.SENT ?? 0} enviados · {data?.last7days.SKIPPED ?? 0} não enviados · {data?.last7days.FAILED ?? 0} falharam
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nº do pedido ou nome" className="w-56" aria-label="Buscar no histórico" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Filtrar por situação">
            <option value="">Todos</option>
            <option value="SENT">Enviados</option>
            <option value="SKIPPED">Não enviados</option>
            <option value="FAILED">Falharam</option>
          </Select>
        </div>
        {!data && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {data?.notices.length === 0 && <p className="py-4 text-sm text-muted-foreground">Nenhum aviso ainda.</p>}
        <div className="divide-y rounded-lg border empty:hidden">
          {data?.notices.map((n) => (
            <div key={n.id} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[90px_1fr_auto] sm:items-center sm:gap-3">
              <span className="font-mono text-xs text-muted-foreground">nº {n.orderNumber}</span>
              <span className="min-w-0">
                <span className="font-medium">{kinds[n.kind]}</span>
                <span className="text-muted-foreground"> · {n.customerName ?? 'cliente'}</span>
                {n.sentTo && n.phone && n.sentTo !== n.phone && <span className="text-muted-foreground"> · teste em {n.sentTo}</span>}
                {n.reason && <span className="block text-xs text-muted-foreground">{n.reason}</span>}
              </span>
              <span className="flex items-center gap-2 sm:justify-end">
                <Badge tone={STATUS[n.status].tone}>{STATUS[n.status].label}</Badge>
                <span className="text-xs text-muted-foreground" title={fmtDateTime(n.updatedAt)}>
                  {timeAgo(n.updatedAt)}
                </span>
                {n.conversationId && (
                  <Link href={`/inbox?c=${n.conversationId}`} className="text-xs font-medium text-primary hover:underline">
                    conversa
                  </Link>
                )}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AvisosPedidoPage() {
  const { data, error, mutate } = useSWR<Data>('/order-notices', fetcher);
  const [draft, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'poll' | 'templates' | null>(null);
  const [testing, setTesting] = useState<Kind | null>(null);

  const cfg = draft ?? data?.config ?? null;

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data || !cfg) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg({ ...cfg, [k]: v });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(data.config);
  const tplByName = new Map(data.templates.map((t) => [t.name, t]));
  const missingTemplates = data.kinds.filter((k) => cfg.kinds[k.key].enabled && !tplByName.has(cfg.kinds[k.key].template));
  const notApproved = data.kinds.filter((k) => cfg.kinds[k.key].enabled && tplByName.get(cfg.kinds[k.key].template) && tplByName.get(cfg.kinds[k.key].template)!.status !== 'APPROVED');
  const situationName = (id: number) => data.situations.find((s) => s.id === id)?.nome ?? `Situação ${id}`;

  async function save(next = cfg!) {
    setSaving(true);
    try {
      const r = await api<{ config: Config }>('/order-notices', { method: 'PUT', body: next });
      await mutate();
      setCfg(null);
      toast.success(r.config.enabled ? 'Salvo. Os avisos estão ligados.' : 'Salvo.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function pollNow() {
    setBusy('poll');
    try {
      const r = await api<{ ran: boolean; reason?: string; baseline?: number; seen: number; sent: number; skipped: number; failed: number }>('/order-notices/poll', { method: 'POST' });
      if (!r.ran) toast.warning(r.reason ?? 'Não rodou');
      else if (r.baseline !== undefined) toast.success(`Primeira leitura: ${r.baseline} pedidos recentes registrados. Nenhum aviso foi enviado para eles.`);
      else toast.success(`${r.seen} pedido(s) alterado(s) · ${r.sent} aviso(s) enviado(s)${r.skipped ? ` · ${r.skipped} não enviado(s)` : ''}${r.failed ? ` · ${r.failed} falha(s)` : ''}`);
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function createTemplates() {
    setBusy('templates');
    try {
      const r = await api<{ results: { name: string; status: string; error?: string }[] }>('/order-notices/templates', { method: 'POST' });
      const errors = r.results.filter((x) => x.error);
      if (errors.length) toast.error(errors.map((x) => `${x.name}: ${x.error}`).join('\n'));
      else toast.success('Templates enviados para a Meta. A aprovação costuma levar de alguns minutos a algumas horas.');
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const st = data.state;

  return (
    <>
      <PageHeader
        title="Avisos de pedido"
        description="Quando a situação do pedido muda no Bling (Kanban, rotina da Duda), o hub manda o aviso certo para a cliente pelo WhatsApp oficial. Um aviso de cada tipo por pedido, nunca repetido."
        actions={
          <Button variant="outline" onClick={pollNow} loading={busy === 'poll'} disabled={!data.config.enabled}>
            <RefreshCw /> Verificar agora
          </Button>
        }
      />

      {!data.blingConnected && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0" /> O Bling não está conectado. Conecte em <Link href="/produtos" className="font-semibold underline">Produtos</Link> para os avisos funcionarem.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Ligar avisos
                {data.config.enabled ? <Badge tone="success">Ligado</Badge> : <Badge>Desligado</Badge>}
                {data.config.enabled && data.config.testPhone && <Badge tone="warning">Modo de teste</Badge>}
              </CardTitle>
              <CardDescription>
                {st.lastRunAt
                  ? `Última leitura do Bling ${timeAgo(st.lastRunAt)}${st.lastSummary ? `: ${st.lastSummary.seen} pedido(s) alterado(s), ${st.lastSummary.sent} aviso(s)` : ''}.`
                  : 'Na primeira leitura o hub só registra os pedidos que já existem. Quem já está no meio do fluxo não recebe aviso atrasado.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {st.lastError && (
                <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {st.lastError}
                </p>
              )}
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-sm">
                <span>
                  <b className="font-medium">Mandar avisos de pedido</b>
                  <span className="block text-xs text-muted-foreground">O Bling é lido a cada 2 minutos.</span>
                </span>
                <Switch checked={cfg.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label="Mandar avisos de pedido" />
              </label>
              <Field
                label="Número de teste (opcional)"
                htmlFor="test-phone"
                hint="Com um número aqui, TODO aviso vai para ele em vez da cliente. Use para conferir antes de ligar de verdade. Deixe vazio para mandar para as clientes."
              >
                <Input id="test-phone" value={cfg.testPhone ?? ''} onChange={(e) => set('testPhone', e.target.value || null)} placeholder="(63) 99999-9999" inputMode="tel" className="max-w-xs" />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Avisos</CardTitle>
              <CardDescription>Cada aviso usa um template aprovado pela Meta. As variáveis são preenchidas com os dados do pedido no Bling.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {(missingTemplates.length > 0 || notApproved.length > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2.5 text-sm">
                  <span>
                    {missingTemplates.length > 0
                      ? `${missingTemplates.length} aviso(s) ainda sem template na Meta.`
                      : `${notApproved.length} template(s) aguardando a Meta. Enquanto isso, esses avisos ficam como "não enviado".`}
                  </span>
                  {missingTemplates.length > 0 && (
                    <Button size="sm" onClick={createTemplates} loading={busy === 'templates'}>
                      <FileText /> Criar templates sugeridos
                    </Button>
                  )}
                </div>
              )}
              {data.kinds.map((k) => {
                const kc = cfg.kinds[k.key];
                const tpl = tplByName.get(kc.template);
                return (
                  <div key={k.key} className={cn('grid gap-2 rounded-lg border p-3', !kc.enabled && 'opacity-60')}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{k.label}</p>
                        <p className="text-xs text-muted-foreground">Quando: {k.when}</p>
                      </div>
                      <Switch checked={kc.enabled} onCheckedChange={(v) => set('kinds', { ...cfg.kinds, [k.key]: { ...kc, enabled: v } })} aria-label={`Ligar aviso ${k.label}`} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Template:</span>
                      <code className="rounded bg-muted px-1.5 py-0.5">{kc.template}</code>
                      {tpl ? (
                        <Badge tone={tpl.status === 'APPROVED' ? 'success' : tpl.status === 'REJECTED' ? 'danger' : 'warning'}>{TEMPLATE_STATUS[tpl.status] ?? tpl.status}</Badge>
                      ) : (
                        <Badge tone="danger">não existe</Badge>
                      )}
                      {tpl?.status === 'APPROVED' && (
                        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => setTesting(k.key)}>
                          <FlaskConical className="size-3.5" /> Testar com um pedido
                        </Button>
                      )}
                    </div>
                    {tpl?.rejectedReason && <p className="text-xs text-destructive">Motivo da Meta: {tpl.rejectedReason}</p>}
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">Texto sugerido e variáveis</summary>
                      <p className="mt-1.5 rounded-md bg-muted/60 p-2 text-[13px] leading-relaxed text-foreground">{k.suggested.body}</p>
                      <p className="mt-1">{k.vars.map((v, i) => `{{${i + 1}}} ${v}`).join(' · ')}</p>
                    </details>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Retirada e envio</CardTitle>
              <CardDescription>“Retirar na loja” nas observações do pedido = retirada. Envio manda o código de rastreio da etiqueta do Bling.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Field label="Endereço e horário da loja" htmlFor="store-info" hint='Vai no aviso "pronto para retirar".'>
                <Textarea id="store-info" value={cfg.storeInfo} onChange={(e) => set('storeInfo', e.target.value)} className="min-h-20" maxLength={300} placeholder="Rua..., nº ..., bairro · seg a sáb, 9h às 18h" />
              </Field>
              <Field label="Link de rastreio" htmlFor="tracking" hint="{codigo} vira o código do pedido.">
                <Input id="tracking" value={cfg.trackingUrl} onChange={(e) => set('trackingUrl', e.target.value)} />
              </Field>
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                <span>
                  <b className="font-medium">“Entregue” e “Cancelado” só para quem já recebeu aviso</b>
                  <span className="block text-xs text-muted-foreground">Evita mensagem em venda de balcão, que já nasce como Atendido.</span>
                </span>
                <Switch checked={cfg.onlyAfterFlow} onCheckedChange={(v) => set('onlyAfterFlow', v)} />
              </label>
              <Field label="Número que envia" htmlFor="number">
                <Select id="number" value={cfg.phoneNumberId ?? ''} onChange={(e) => set('phoneNumberId', e.target.value || null)}>
                  <option value="">Primeiro número de atendimento</option>
                  {data.numbers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.displayName} {n.displayPhone ? `(${n.displayPhone})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Situações do Bling</CardTitle>
              <CardDescription>Qual situação da sua conta corresponde a cada etapa. Já vem preenchido pelo nome.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2.5">
              {data.situationsError && <p className="text-xs text-destructive">Não foi possível ler as situações do Bling: {data.situationsError}</p>}
              {data.groups.map((g) => (
                <div key={g.key} className="grid grid-cols-[1fr_1.1fr] items-center gap-3 text-sm">
                  <span>{g.label}</span>
                  <Select
                    value={String(cfg.situations[g.key][0] ?? '')}
                    onChange={(e) => set('situations', { ...cfg.situations, [g.key]: e.target.value ? [Number(e.target.value)] : [] })}
                    aria-label={`Situação do Bling para ${g.label}`}
                    className="h-9"
                  >
                    <option value="">— nenhuma —</option>
                    {cfg.situations[g.key][0] && !data.situations.some((s) => s.id === cfg.situations[g.key][0]) && (
                      <option value={cfg.situations[g.key][0]}>{situationName(cfg.situations[g.key][0]!)}</option>
                    )}
                    {data.situations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nome}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Lojas sem aviso</CardTitle>
              <CardDescription>Pedidos dessas lojas do Bling não recebem WhatsApp. A loja TikTok fica sempre de fora.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {data.stores.length === 0 && <p className="text-sm text-muted-foreground">As lojas aparecem aqui depois da primeira leitura do Bling.</p>}
              {data.stores.map((s) => (
                <label key={s.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span>
                    Loja {s.id} {s.tiktok && <Badge>TikTok</Badge>}
                    <span className="block text-xs text-muted-foreground">{s.orders} pedido(s) lido(s)</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    sem aviso
                    <Switch
                      checked={cfg.excludedStores.includes(s.id)}
                      disabled={s.tiktok}
                      onCheckedChange={(v) => set('excludedStores', v ? [...cfg.excludedStores, s.id] : cfg.excludedStores.filter((x) => x !== s.id))}
                    />
                  </span>
                </label>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-4">
        <History />
      </div>

      <div
        className={cn(
          'sticky bottom-20 z-20 mt-4 flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur transition-opacity lg:bottom-4',
          dirty ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <span className="text-sm">Alterações não salvas</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setCfg(null)}>
            Desfazer
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            <Save /> Salvar
          </Button>
        </div>
      </div>
      {!dirty && data.config.saved && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5" /> Configuração salva.
        </p>
      )}

      <TestDialog kind={testing} label={data.kinds.find((k) => k.key === testing)?.label ?? ''} onClose={() => setTesting(null)} />
    </>
  );
}
