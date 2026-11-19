'use client';

import { BellRing, Copy, FileText, KeyRound, Pencil, Save, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type { TeamUser, UserRole } from '@/lib/types';
import { cn, fmtDateTime, timeAgo } from '@/lib/utils';

const ROLE_LABEL: Record<UserRole, string> = { ADMIN: 'Administrador', ATENDENTE: 'Atendente' };

/** Senha inicial forte e fácil de ditar: Palavra-1234-palavra! */
function generatePassword(): string {
  const words = ['Rosa', 'Ambar', 'Cedro', 'Lirio', 'Musgo', 'Baunilha', 'Jasmim', 'Canela', 'Oud', 'Sandalo', 'Neroli', 'Iris'];
  const r = crypto.getRandomValues(new Uint32Array(3));
  const w1 = words[r[0]! % words.length]!;
  const w2 = words[r[1]! % words.length]!.toLowerCase();
  return `${w1}-${String(1000 + (r[2]! % 9000))}-${w2}!`;
}

function PasswordInput({ id, name, required, value, onChange }: { id: string; name: string; required?: boolean; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input id={id} name={name} required={required} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" className="font-mono" />
      <Button type="button" variant="outline" onClick={() => onChange(generatePassword())} title="Gerar uma senha forte">
        <KeyRound /> Gerar
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={!value}
        aria-label="Copiar senha"
        onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success('Senha copiada'), () => toast.error('Não foi possível copiar'))}
      >
        <Copy />
      </Button>
    </div>
  );
}

type Alerts = { phone: string; alertNewOrders: boolean; alertStuck: boolean; alertDaily: boolean; alertSystem: boolean };
const NO_ALERTS: Alerts = { phone: '', alertNewOrders: false, alertStuck: false, alertDaily: false, alertSystem: true };
const ALERT_LABEL: [keyof Omit<Alerts, 'phone'>, string, string][] = [
  ['alertNewOrders', 'Pedido novo para separar', 'Quando um pedido entra em Separando (Duda, Gabi)'],
  ['alertStuck', 'Pedidos parados', 'Uma vez por dia: há mais de 1 dia em Separando ou Emitir etiqueta'],
  ['alertDaily', 'Resumo do dia', 'No fim do dia: quantos pedidos saíram e quantos ficaram'],
  ['alertSystem', 'Alertas do sistema', 'Só para administradores: Bling desconectado, leitura de pedidos parada, número com problema'],
];

/** WhatsApp da pessoa e quais avisos internos ela recebe. */
function AlertFields({ value, onChange, id }: { value: Alerts; onChange: (v: Alerts) => void; id: string }) {
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <Field label="WhatsApp (para os avisos da equipe)" htmlFor={`${id}-phone`} hint="Opcional. Com DDD.">
        <Input id={`${id}-phone`} value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} inputMode="tel" placeholder="(63) 99999-9999" />
      </Field>
      {ALERT_LABEL.map(([k, label, hint]) => (
        <label key={k} className={cn('flex items-center justify-between gap-3 text-sm', !value.phone.trim() && 'opacity-50')}>
          <span>
            {label}
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </span>
          <Switch checked={value[k]} disabled={!value.phone.trim()} onCheckedChange={(v) => onChange({ ...value, [k]: v })} />
        </label>
      ))}
    </div>
  );
}

function NewUserDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [alerts, setAlerts] = useState<Alerts>(NO_ALERTS);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api('/team', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), role: f.get('role'), password, ...alerts, phone: alerts.phone.trim() || null } });
      setAlerts(NO_ALERTS);
      toast.success('Acesso criado. Passe o e-mail e a senha para a pessoa.');
      setPassword('');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar pessoa</DialogTitle>
          <DialogDescription>Cada pessoa entra com o próprio e-mail e senha. Depois ela pode trocar a senha e ativar a verificação em duas etapas em Segurança.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Nome" htmlFor="nu-name">
            <Input id="nu-name" name="name" required minLength={2} maxLength={60} placeholder="Ex.: Duda" autoFocus />
          </Field>
          <Field label="E-mail" htmlFor="nu-email">
            <Input id="nu-email" name="email" type="email" required autoComplete="off" />
          </Field>
          <Field label="Papel" htmlFor="nu-role" hint="Administrador também gerencia a equipe. Atendente usa o resto do painel.">
            <Select id="nu-role" name="role" defaultValue="ATENDENTE">
              <option value="ATENDENTE">Atendente</option>
              <option value="ADMIN">Administrador</option>
            </Select>
          </Field>
          <Field label="Senha inicial" htmlFor="nu-pass" hint="Mín. 10 caracteres, com 3 destes: minúscula, maiúscula, número e símbolo.">
            <PasswordInput id="nu-pass" name="password" required value={password} onChange={setPassword} />
          </Field>
          <AlertFields id="nu" value={alerts} onChange={setAlerts} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={busy}>
              Criar acesso
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onSaved }: { user: TeamUser | null; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(true);
  const [reset2fa, setReset2fa] = useState(false);
  const [alerts, setAlerts] = useState<Alerts>(NO_ALERTS);
  const [lastId, setLastId] = useState<string | null>(null);
  if (user && user.id !== lastId) {
    // abriu para outra pessoa: zera o formulário
    setLastId(user.id);
    setPassword('');
    setActive(user.active);
    setReset2fa(false);
    setAlerts({ phone: user.phone ?? '', alertNewOrders: user.alertNewOrders, alertStuck: user.alertStuck, alertDaily: user.alertDaily, alertSystem: user.alertSystem });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api(`/team/${user.id}`, {
        method: 'PATCH',
        body: {
          name: f.get('name'),
          email: f.get('email'),
          ...(user.me ? {} : { role: f.get('role'), active }),
          ...(password ? { password } : {}),
          ...(reset2fa ? { resetTwoFactor: true } : {}),
          ...alerts,
          phone: alerts.phone.trim() || null,
        },
      });
      toast.success('Acesso atualizado');
      onClose();
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {user && (
          <>
            <DialogHeader>
              <DialogTitle>Editar {user.name || user.email}</DialogTitle>
              <DialogDescription>
                {user.me ? 'Este é o seu acesso. Para trocar sua senha com a senha atual, use Segurança.' : 'Mudar a senha, desativar ou zerar a verificação em duas etapas encerra as sessões abertas dessa pessoa.'}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-3">
              <Field label="Nome" htmlFor="eu-name">
                <Input id="eu-name" name="name" required minLength={2} maxLength={60} defaultValue={user.name} />
              </Field>
              <Field label="E-mail" htmlFor="eu-email">
                <Input id="eu-email" name="email" type="email" required defaultValue={user.email} />
              </Field>
              {!user.me && (
                <>
                  <Field label="Papel" htmlFor="eu-role">
                    <Select id="eu-role" name="role" defaultValue={user.role}>
                      <option value="ATENDENTE">Atendente</option>
                      <option value="ADMIN">Administrador</option>
                    </Select>
                  </Field>
                  <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                    <span>
                      <b className="font-medium">Acesso ativo</b>
                      <span className="block text-xs text-muted-foreground">Desativado não entra mais. As conversas dessa pessoa voltam para a fila.</span>
                    </span>
                    <Switch checked={active} onCheckedChange={setActive} />
                  </label>
                </>
              )}
              <Field label="Nova senha (opcional)" htmlFor="eu-pass" hint="Deixe em branco para manter a senha atual.">
                <PasswordInput id="eu-pass" name="password" value={password} onChange={setPassword} />
              </Field>
              <AlertFields id="eu" value={alerts} onChange={setAlerts} />
              {user.twoFactor && !user.me && (
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                  <span>
                    <b className="font-medium">Zerar verificação em duas etapas</b>
                    <span className="block text-xs text-muted-foreground">Use se a pessoa perdeu o celular e os códigos de recuperação.</span>
                  </span>
                  <Switch checked={reset2fa} onCheckedChange={setReset2fa} />
                </label>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancelar
                </Button>
                <Button type="submit" loading={busy}>
                  Salvar
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function EquipePage() {
  const { data, error, mutate } = useSWR<{ users: TeamUser[] }>('/team', fetcher);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamUser | null>(null);

  return (
    <>
      <PageHeader
        title="Equipe"
        description="Quem pode entrar no painel. Cada pessoa tem o próprio login, e as conversas mostram quem está atendendo."
        actions={
          data && (
            <Button onClick={() => setAdding(true)}>
              <UserPlus /> Adicionar pessoa
            </Button>
          )
        }
      />
      {error && <p className="text-sm text-muted-foreground">{(error as Error).message}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data && (
        <Card>
          <CardContent className="divide-y p-0">
            {data.users.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap">
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary font-display text-base font-semibold text-secondary-foreground">
                  {(u.name || u.email).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {u.name || u.email.split('@')[0]}
                    {u.me && <Badge tone="brand">você</Badge>}
                    <Badge tone={u.role === 'ADMIN' ? 'brand' : 'neutral'}>{ROLE_LABEL[u.role]}</Badge>
                    {!u.active && <Badge tone="danger">Desativado</Badge>}
                    {u.active && !u.twoFactor && <Badge tone="warning">Sem 2 etapas</Badge>}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">{u.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.lastLoginAt ? `Último acesso ${fmtDateTime(u.lastLoginAt)}` : 'Ainda não entrou'}
                    {u.openConversations ? ` · ${u.openConversations} em atendimento` : ''}
                    {u.phone ? ` · WhatsApp ${u.phone}` : ''}
                    {[u.alertNewOrders && 'pedidos novos', u.alertStuck && 'parados', u.alertDaily && 'resumo'].filter(Boolean).length > 0 &&
                      ` · avisos: ${[u.alertNewOrders && 'pedidos novos', u.alertStuck && 'parados', u.alertDaily && 'resumo'].filter(Boolean).join(', ')}`}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditing(u)}>
                  <Pencil /> Editar
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {data && <TeamAlertsCard />}
      <NewUserDialog open={adding} onOpenChange={setAdding} onSaved={() => void mutate()} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} onSaved={() => void mutate()} />
    </>
  );
}

interface AlertsData {
  config: { stuckHour: number; summaryHour: number; phoneNumberId: string | null; templates: Record<string, string> };
  kinds: { key: string; label: string; when: string; body: string; template: { name: string; status: string; rejectedReason: string | null } | null }[];
  log: { id: string; kind: string; status: 'SENT' | 'FAILED'; text: string | null; reason: string | null; userName: string | null; createdAt: string }[];
}

/** Configuração dos avisos internos (horários e templates) + últimos avisos enviados. */
function TeamAlertsCard() {
  const { data, mutate } = useSWR<AlertsData>('/team/alerts', fetcher);
  const [draft, setDraft] = useState<AlertsData['config'] | null>(null);
  const [busy, setBusy] = useState<'save' | 'tpl' | null>(null);
  if (!data) return null;
  const cfg = draft ?? data.config;
  const missing = data.kinds.filter((k) => !k.template).length;

  async function run(kind: 'save' | 'tpl') {
    setBusy(kind);
    try {
      if (kind === 'save') {
        await api('/team/alerts', { method: 'PUT', body: cfg });
        toast.success('Horários salvos');
        setDraft(null);
      } else {
        const r = await api<{ results: { name: string; error?: string }[] }>('/team/alerts/templates', { method: 'POST' });
        const errs = r.results.filter((x) => x.error);
        if (errs.length) toast.error(errs.map((x) => `${x.name}: ${x.error}`).join('\n'));
        else toast.success('Templates enviados para a Meta aprovar.');
      }
      await mutate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" /> Avisos para a equipe
        </CardTitle>
        <CardDescription>
          Pelo WhatsApp de cada pessoa (Editar → WhatsApp e avisos). Mostram só o nº do pedido e o nome da cliente, como a rotina da Duda. Funcionam mesmo com os avisos às clientes desligados.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <div className="flex flex-wrap gap-3">
            <Field label="Pedidos parados: a partir de" htmlFor="ta-stuck">
              <Select id="ta-stuck" value={cfg.stuckHour} onChange={(e) => setDraft({ ...cfg, stuckHour: Number(e.target.value) })} className="w-28">
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h}h
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Resumo do dia: a partir de" htmlFor="ta-sum">
              <Select id="ta-sum" value={cfg.summaryHour} onChange={(e) => setDraft({ ...cfg, summaryHour: Number(e.target.value) })} className="w-28">
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h}h
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button size="sm" onClick={() => void run('save')} loading={busy === 'save'} disabled={!draft} className="justify-self-start">
            <Save /> Salvar horários
          </Button>
          {missing > 0 && (
            <Button size="sm" variant="outline" onClick={() => void run('tpl')} loading={busy === 'tpl'} className="justify-self-start">
              <FileText /> Criar templates dos avisos ({missing})
            </Button>
          )}
          {data.kinds.map((k) => (
            <div key={k.key} className="grid gap-0.5 rounded-lg border p-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <b className="font-medium">{k.label}</b>
                {k.template ? <Badge tone={k.template.status === 'APPROVED' ? 'success' : k.template.status === 'REJECTED' ? 'danger' : 'warning'}>{k.template.status === 'APPROVED' ? 'aprovado' : k.template.status === 'REJECTED' ? 'recusado' : 'em análise'}</Badge> : <Badge tone="danger">sem template</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">{k.when}</p>
              <p className="text-xs">{k.body}</p>
            </div>
          ))}
        </div>
        <div className="grid content-start gap-2">
          <p className="text-sm font-medium">Últimos avisos</p>
          {data.log.length === 0 && <p className="text-sm text-muted-foreground">Nenhum aviso enviado ainda.</p>}
          <div className="divide-y rounded-lg border empty:hidden">
            {data.log.map((l) => (
              <div key={l.id} className="grid gap-0.5 px-3 py-2 text-sm">
                <p className="flex items-center justify-between gap-2">
                  <span className="font-medium">{l.userName}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone={l.status === 'SENT' ? 'success' : 'danger'}>{l.status === 'SENT' ? 'enviado' : 'falhou'}</Badge>
                    {timeAgo(l.createdAt)}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{l.reason ?? l.text}</p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
