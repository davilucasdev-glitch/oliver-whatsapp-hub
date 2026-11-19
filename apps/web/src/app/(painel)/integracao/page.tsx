'use client';

import { AlertTriangle, Copy, FileText, KeyRound, Plug, Send, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import { fmtDateTime, timeAgo } from '@/lib/utils';

interface Data {
  apiBase: string;
  token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null;
  webhook: { url: string; hasSecret: boolean; events: string[] };
  allEvents: string[];
  campaignTemplate: { name: string; body: string; template: { name: string; status: string; rejectedReason: string | null } | null };
  appIdSet: boolean;
  stats: { siteMessages7d: number; openCarts: number };
  logs: { id: string; event: string; ok: boolean; httpStatus: number | null; error: string | null; createdAt: string }[];
}

const EVENT_LABEL: Record<string, string> = {
  'message.received': 'Mensagem recebida (atendimento, comprovante, SAIR)',
  'message.status': 'Status de cada envio do site (enviada, entregue, lida, falhou)',
  'contact.opt_out': 'Alguém pediu para sair',
};

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success('Copiado'),
    () => toast.error('Não foi possível copiar'),
  );
}

function Secret({ title, value, onClose, hint }: { title: string; value: string | null; onClose: () => void; hint: string }) {
  return (
    <Dialog open={Boolean(value)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-lg border bg-muted/50 p-3 font-mono text-sm">{value}</p>
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs">Guarde agora (no arquivo de configuração do site). Ela não aparece de novo; se perder, gere outra.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => value && copy(value)}>
            <Copy /> Copiar
          </Button>
          <Button onClick={onClose}>Já guardei</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DOCS: { method: string; path: string; what: string; body?: string }[] = [
  { method: 'GET', path: '/templates', what: 'Templates aprovados, com quantas variáveis e se pedem anexo (o site só usa template aprovado).' },
  {
    method: 'POST',
    path: '/messages',
    what: 'Envia um template para um telefone (pedido, cobrança, extrato). "ref" evita mandar duas vezes. Anexo: attachment.url (https) ou attachment.base64.',
    body: '{ "phone": "5563992142094", "template": "pedido_separando", "variables": ["Gisele", "8814"], "ref": "pedido-8814-separando" }',
  },
  { method: 'POST', path: '/opt-in', what: 'Registra o consentimento vindo do site (LGPD: guarda quando e de onde).', body: '{ "phone": "5563992142094", "name": "Gisele", "source": "checkout", "at": "2026-11-18T12:00:00Z" }' },
  { method: 'GET', path: '/opt-outs?since=2026-11-01T00:00:00Z', what: 'Quem pediu para sair (o site não manda campanha para eles).' },
  {
    method: 'POST',
    path: '/campaigns',
    what: 'Arte de post do painel vira campanha em RASCUNHO (só sai depois de um administrador aprovar aqui no hub). segment: varejo | atacado | todos.',
    body: '{ "name": "Chegou: novidades", "text": "Chegaram as novidades da semana...", "segment": "varejo", "phones": ["5563992142094"], "image": { "base64": "...", "mime": "image/jpeg" }, "ref": "arte-2026-11-18" }',
  },
  {
    method: 'POST',
    path: '/carts',
    what: 'Carrinho parado no site (aparece em Relacionamento → Carrinho para quem tem opt-in). Quando virar pedido: POST /carts/{ref}/recovered.',
    body: '{ "ref": "cart-abc", "phone": "5563992142094", "name": "Gisele", "items": [{ "name": "Asad 100ml", "qty": 1 }], "total": 189.9, "link": "https://.../carrinho/abc" }',
  },
  { method: 'GET', path: '/media/{messageId}', what: 'Arquivo de uma mensagem recebida (ex.: comprovante), com o id que vem no aviso message.received.' },
];

export default function IntegracaoPage() {
  const { data, error, mutate } = useSWR<Data>('/integration', fetcher);
  const [secret, setSecret] = useState<{ title: string; value: string; hint: string } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <p className="text-sm text-muted-foreground">{(error as Error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const hookUrl = url ?? data.webhook.url;
  const hookEvents = events ?? data.webhook.events;

  async function run<T>(key: string, fn: () => Promise<T>) {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      toast.error((err as Error).message);
      return null;
    } finally {
      setBusy(null);
      void mutate();
    }
  }

  return (
    <>
      <PageHeader title="Integração com o site" description="O site e o painel da Oliver (PHP na Hostinger) usam o hub para mandar WhatsApp pelo número oficial e recebem de volta as respostas e os status." />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="size-4" /> Chave de acesso do site
              </CardTitle>
              <CardDescription>Vai no cabeçalho de cada chamada: Authorization: Bearer &lt;chave&gt;. Nunca na URL.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                Endereço da API: <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{data.apiBase}</code>
                <Button variant="ghost" size="sm" onClick={() => copy(data.apiBase)} aria-label="Copiar endereço">
                  <Copy />
                </Button>
              </p>
              {data.token ? (
                <p>
                  Chave <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{data.token.prefix}…</code> criada em {fmtDateTime(data.token.createdAt)} · {data.token.lastUsedAt ? `usada ${timeAgo(data.token.lastUsedAt)}` : 'ainda não usada'}
                </p>
              ) : (
                <p className="text-muted-foreground">Nenhuma chave ainda.</p>
              )}
              <Button
                className="justify-self-start"
                variant={data.token ? 'outline' : 'default'}
                loading={busy === 'token'}
                onClick={() =>
                  void run('token', async () => {
                    if (data.token && !window.confirm('Gerar outra chave? A atual para de funcionar na hora (o site precisa ser atualizado).')) return;
                    const r = await api<{ token: string }>('/integration/token', { method: 'POST' });
                    setSecret({ title: 'Chave do site', value: r.token, hint: 'Coloque no arquivo de configuração do site (ex.: OLIVER_HUB_TOKEN).' });
                  })
                }
              >
                <KeyRound /> {data.token ? 'Gerar outra chave' : 'Gerar chave'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Últimos 7 dias: {data.stats.siteMessages7d} envio(s) pedido(s) pelo site · {data.stats.openCarts} carrinho(s) em aberto.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="size-4" /> Avisos para o site
              </CardTitle>
              <CardDescription>O hub chama uma URL do site (POST, JSON) a cada evento. A assinatura vem no cabeçalho X-Oliver-Signature: sha256=HMAC do corpo com o segredo.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Field label="URL do site" htmlFor="hook-url">
                <Input id="hook-url" value={hookUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://blackfridaydaoliver.com/hub-webhook.php" />
              </Field>
              {data.allEvents.map((ev) => (
                <label key={ev} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    <code className="text-xs">{ev}</code>
                    <span className="block text-xs text-muted-foreground">{EVENT_LABEL[ev]}</span>
                  </span>
                  <Switch checked={hookEvents.includes(ev)} onCheckedChange={(v) => setEvents(v ? [...hookEvents, ev] : hookEvents.filter((x) => x !== ev))} />
                </label>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  loading={busy === 'hook'}
                  disabled={url === null && events === null}
                  onClick={() =>
                    void run('hook', async () => {
                      const r = await api<{ secret: string | null }>('/integration/webhook', { method: 'PUT', body: { url: hookUrl, events: hookEvents } });
                      setUrl(null);
                      setEvents(null);
                      toast.success('Salvo');
                      if (r.secret) setSecret({ title: 'Segredo da assinatura', value: r.secret, hint: 'O site usa para conferir que o aviso veio mesmo do hub.' });
                    })
                  }
                >
                  Salvar
                </Button>
                {data.webhook.url && (
                  <Button variant="outline" loading={busy === 'test'} onClick={() => void run('test', async () => (await api('/integration/webhook/test', { method: 'POST' }), toast.success('O site respondeu OK')))}>
                    <Send /> Testar
                  </Button>
                )}
                {data.webhook.hasSecret && (
                  <Button
                    variant="ghost"
                    loading={busy === 'secret'}
                    onClick={() =>
                      void run('secret', async () => {
                        if (!window.confirm('Gerar outro segredo? O site precisa ser atualizado para continuar aceitando os avisos.')) return;
                        const r = await api<{ secret: string }>('/integration/webhook/secret', { method: 'POST' });
                        setSecret({ title: 'Segredo da assinatura', value: r.secret, hint: 'O site usa para conferir que o aviso veio mesmo do hub.' });
                      })
                    }
                  >
                    <ShieldCheck /> Gerar outro segredo
                  </Button>
                )}
              </div>
              <p className="text-sm font-medium">Últimas entregas</p>
              {data.logs.length === 0 && <p className="text-sm text-muted-foreground">Nenhum aviso enviado ainda.</p>}
              <div className="divide-y rounded-lg border empty:hidden">
                {data.logs.map((l) => (
                  <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <code>{l.event}</code>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {l.error && <span className="text-destructive">{l.error}</span>}
                      <Badge tone={l.ok ? 'success' : 'danger'}>{l.ok ? `OK ${l.httpStatus ?? ''}` : 'falhou'}</Badge>
                      {timeAgo(l.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Campanhas do painel</CardTitle>
              <CardDescription>A arte de post do painel (mais vendidos, novidades, Black Friday) vira campanha com a imagem no cabeçalho e o botão “Quero”. Chega como rascunho: um administrador confere a arte e o público e inicia.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                Template <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{data.campaignTemplate.name}</code>
                {data.campaignTemplate.template ? (
                  <Badge tone={data.campaignTemplate.template.status === 'APPROVED' ? 'success' : data.campaignTemplate.template.status === 'REJECTED' ? 'danger' : 'warning'}>
                    {data.campaignTemplate.template.status === 'APPROVED' ? 'aprovado' : data.campaignTemplate.template.status === 'REJECTED' ? 'recusado' : 'em análise'}
                  </Badge>
                ) : (
                  <Badge tone="danger">não existe</Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">[arte] {data.campaignTemplate.body} [Quero] [Parar promoções]</p>
              {data.campaignTemplate.template?.rejectedReason && <p className="text-xs text-destructive">Motivo da Meta: {data.campaignTemplate.template.rejectedReason}</p>}
              {!data.appIdSet && (
                <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Para criar, preencha META_APP_ID no .env (a Meta pede uma imagem de exemplo).
                </p>
              )}
              {!data.campaignTemplate.template && (
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  loading={busy === 'tpl'}
                  onClick={() => void run('tpl', async () => (await api('/integration/campaign-template', { method: 'POST' }), toast.success('Template enviado para a Meta aprovar.')))}
                >
                  <FileText /> Criar template da campanha
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>O que o site pode chamar</CardTitle>
              <CardDescription>Tudo em {data.apiBase}, com a chave no cabeçalho. Respostas em JSON; erro vem com {'{ "error": "motivo" }'}.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {DOCS.map((d) => (
                <div key={d.path} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <p className="flex items-center gap-2">
                    <Badge tone={d.method === 'GET' ? 'neutral' : 'brand'}>{d.method}</Badge>
                    <code className="text-xs">{d.path}</code>
                  </p>
                  <p className="text-xs text-muted-foreground">{d.what}</p>
                  {d.body && <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 text-[11px]">{d.body}</pre>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
      <Secret title={secret?.title ?? ''} value={secret?.value ?? null} hint={secret?.hint ?? ''} onClose={() => setSecret(null)} />
    </>
  );
}
