'use client';

import { Copy, Download, KeyRound, LogOut, MonitorSmartphone, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';

interface Security {
  twoFactor: boolean;
  twoFactorSince: string | null;
  recoveryCodesLeft: number;
  sessions: { id: string; ip: string | null; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean }[];
}

function deviceName(ua: string | null): string {
  if (!ua) return 'Dispositivo desconhecido';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' no ') || ua.slice(0, 40);
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Oliver Hub — códigos de recuperação\nCada código funciona uma vez, no lugar do código do app.\n\n${codes.join('\n')}\n`;
  return (
    <div className="grid gap-3">
      <p className="rounded-md bg-warning-soft p-3 text-sm">
        <b>Guarde estes códigos agora</b> (gerenciador de senhas ou papel em local seguro). Eles não aparecem de novo. Se perder o celular, é com eles que você entra.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join('\n')).then(
              () => toast.success('Códigos copiados'),
              () => toast.error('Não foi possível copiar'),
            )
          }
        >
          <Copy /> Copiar
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="oliver-hub-codigos-recuperacao.txt">
            <Download /> Baixar .txt
          </a>
        </Button>
        <Button size="sm" onClick={onDone}>
          Já guardei
        </Button>
      </div>
    </div>
  );
}

function TwoFactorCard({ data, refresh }: { data: Security; refresh: () => void }) {
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'>('idle');
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      if (step === 'password') {
        setSetup(await api<{ secret: string; qrSvg: string }>('/auth/2fa/setup', { method: 'POST', body: { password: f.get('password') } }));
        setStep('scan');
      } else if (step === 'scan') {
        const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code: f.get('code') } });
        setCodes(r.recoveryCodes);
        setStep('codes');
        toast.success('Verificação em duas etapas ativada');
        refresh();
      } else if (step === 'disable') {
        await api('/auth/2fa/disable', { method: 'POST', body: { password: f.get('password'), code: f.get('code') } });
        toast.success('Verificação em duas etapas desativada');
        setStep('idle');
        refresh();
      } else if (step === 'regen') {
        const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST', body: { code: f.get('code') } });
        setCodes(r.recoveryCodes);
        setStep('codes');
        refresh();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Verificação em duas etapas
          {data.twoFactor ? <Badge tone="success">Ativa</Badge> : <Badge tone="warning">Desativada</Badge>}
        </CardTitle>
        <CardDescription>
          Além da senha, o login pede um código de 6 dígitos do app autenticador do seu celular (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).
          {data.twoFactor && data.twoFactorSince ? ` Ativa desde ${fmtDateTime(data.twoFactorSince)}.` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {step === 'codes' && (
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setCodes([]);
              setStep('idle');
            }}
          />
        )}

        {step === 'idle' && !data.twoFactor && (
          <Button className="justify-self-start" onClick={() => setStep('password')}>
            <ShieldCheck /> Ativar
          </Button>
        )}
        {step === 'idle' && data.twoFactor && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Códigos de recuperação restantes: <b className="text-foreground">{data.recoveryCodesLeft}</b>
              {data.recoveryCodesLeft <= 3 ? ' (gere novos)' : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setStep('regen')}>
                <KeyRound /> Gerar novos códigos de recuperação
              </Button>
              <Button variant="ghost" onClick={() => setStep('disable')}>
                <ShieldOff /> Desativar
              </Button>
            </div>
          </div>
        )}

        {step === 'password' && (
          <form onSubmit={submit} className="grid max-w-sm gap-3">
            <Field label="Confirme sua senha" htmlFor="tf-pass">
              <Input id="tf-pass" name="password" type="password" required autoComplete="current-password" autoFocus />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={busy}>
                Continuar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('idle')}>
                Cancelar
              </Button>
            </div>
          </form>
        )}

        {step === 'scan' && setup && (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[180px_1fr] sm:items-start">
            <div className="size-44 rounded-lg border bg-white p-2 [&_svg]:h-full [&_svg]:w-full" aria-label="QR Code para o app autenticador" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
            <div className="grid gap-3">
              <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
                <li>No app autenticador, toque em adicionar (+) e leia o QR Code.</li>
                <li>
                  Sem câmera? Digite a chave: <code className="break-all font-mono text-foreground">{setup.secret}</code>
                </li>
                <li>Digite abaixo o código de 6 dígitos que aparecer.</li>
              </ol>
              <Field label="Código do app" htmlFor="tf-code">
                <Input id="tf-code" name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="w-40 text-lg tracking-[0.2em]" autoFocus />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" loading={busy}>
                  Ativar
                </Button>
                <Button type="button" variant="ghost" onClick={() => setStep('idle')}>
                  Cancelar
                </Button>
              </div>
            </div>
          </form>
        )}

        {(step === 'disable' || step === 'regen') && (
          <form onSubmit={submit} className="grid max-w-sm gap-3">
            {step === 'disable' && (
              <Field label="Sua senha" htmlFor="tf-dpass">
                <Input id="tf-dpass" name="password" type="password" required autoComplete="current-password" autoFocus />
              </Field>
            )}
            <Field label={step === 'disable' ? 'Código do app (ou de recuperação)' : 'Código do app'} htmlFor="tf-dcode">
              <Input id="tf-dcode" name="code" required autoComplete="one-time-code" maxLength={11} autoFocus={step === 'regen'} />
            </Field>
            {step === 'regen' && <p className="text-xs text-muted-foreground">Os códigos de recuperação antigos deixam de funcionar.</p>}
            <div className="flex gap-2">
              <Button type="submit" variant={step === 'disable' ? 'destructive' : 'default'} loading={busy}>
                {step === 'disable' ? 'Desativar' : 'Gerar novos'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('idle')}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get('next') !== f.get('confirm')) return toast.error('A nova senha e a confirmação não conferem.');
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      toast.success('Senha alterada. As outras sessões foram encerradas.');
      form.reset();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Senha</CardTitle>
        <CardDescription>Mín. 10 caracteres, com 3 destes: minúscula, maiúscula, número e símbolo. Trocar a senha encerra as outras sessões.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-sm gap-3">
          <Field label="Senha atual" htmlFor="pw-cur">
            <Input id="pw-cur" name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="Nova senha" htmlFor="pw-new">
            <Input id="pw-new" name="next" type="password" required autoComplete="new-password" />
          </Field>
          <Field label="Confirmar nova senha" htmlFor="pw-conf">
            <Input id="pw-conf" name="confirm" type="password" required autoComplete="new-password" />
          </Field>
          <Button type="submit" variant="outline" className="justify-self-start" loading={busy}>
            Alterar senha
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SegurancaPage() {
  const { data, mutate } = useSWR<Security>('/auth/security', fetcher);
  const [busy, setBusy] = useState(false);
  const others = data?.sessions.filter((s) => !s.current).length ?? 0;

  return (
    <>
      <PageHeader title="Segurança" description="Senha, verificação em duas etapas e onde o painel está aberto." />
      {!data && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-4">
            <TwoFactorCard data={data} refresh={() => void mutate()} />
            <PasswordCard />
          </div>
          <Card className="content-start">
            <CardHeader>
              <CardTitle>Sessões abertas</CardTitle>
              <CardDescription>Cada navegador ou celular onde você entrou no painel.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="divide-y rounded-lg border">
                {data.sessions.map((s) => (
                  <div key={s.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                    <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {deviceName(s.userAgent)} {s.current && <Badge tone="brand">este</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Entrou em {fmtDateTime(s.createdAt)}
                        {s.ip ? ` · IP ${s.ip}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={others === 0}
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  api('/auth/sessions/revoke-others', { method: 'POST' })
                    .then(() => {
                      toast.success('Outras sessões encerradas');
                      return mutate();
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <LogOut /> Sair dos outros dispositivos ({others})
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
