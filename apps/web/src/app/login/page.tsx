'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BrandMark, BrandName } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { api } from '@/lib/api';
import type { AuthStatus } from '@/lib/types';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** senha certa + 2FA ativo: falta o código do app */
  const [challenge, setChallenge] = useState<string | null>(null);

  useEffect(() => {
    api<AuthStatus>('/auth/status')
      .then((s) => {
        if (s.user) router.replace(params.get('voltar') || '/');
        else setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [router, params]);

  const setup = status?.setupRequired;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    if (setup && f.get('password') !== f.get('confirm')) {
      setError('As senhas não conferem.');
      return;
    }
    setLoading(true);
    try {
      if (challenge) {
        const r = await api<{ usedRecoveryCode?: boolean; recoveryCodesLeft?: number }>('/auth/login/2fa', {
          method: 'POST',
          body: { challenge, code: f.get('code') },
        });
        if (r.usedRecoveryCode) {
          toast.warning(`Você entrou com um código de recuperação. Restam ${r.recoveryCodesLeft}. Gere novos em Segurança se estiverem acabando.`, { duration: 10_000 });
        }
        router.replace(params.get('voltar') || '/');
        return;
      }
      const res = await api<{ twoFactorRequired?: boolean; challenge?: string }>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: {
          email: f.get('email'),
          password: f.get('password'),
          ...(setup ? { setupToken: f.get('setupToken') } : {}),
        },
      });
      if (res.twoFactorRequired && res.challenge) {
        setChallenge(res.challenge);
        return;
      }
      if (setup) toast.success('Acesso criado. Bem-vinda(o) ao Oliver Hub!');
      router.replace(params.get('voltar') || '/');
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      // desafio expirado ou tentativas demais: volta para a senha
      if (challenge && /senha de novo/.test(msg)) setChallenge(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <BrandMark />
          <BrandName />
        </div>
        <div className="max-w-md">
          <p className="font-display text-4xl leading-[1.15]">Atendimento e campanhas da Oliver, num lugar só.</p>
          <p className="mt-4 text-sm text-sidebar-muted">
            Uso interno da Oliver Cosmetics. API oficial do WhatsApp Business, com opt-in, opt-out e ritmo de envio controlados.
          </p>
        </div>
        <p className="text-xs text-sidebar-muted">Oliver Cosmetics LTDA</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-[radial-gradient(circle,oklch(0.55_0.12_335/0.45),transparent_65%)]"
        />
      </section>

      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <BrandName />
          </div>
          {!status && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!status && error && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-[oklch(0.45_0.17_25)]">
              {error}
            </p>
          )}
          {status && challenge && (
            <>
              <h1 className="font-display text-2xl font-semibold tracking-tight">Código de verificação</h1>
              <p className="mt-1 text-sm text-muted-foreground">Abra o app autenticador no celular e digite o código de 6 dígitos do Oliver Hub.</p>
              <form key="code" onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
                <Field label="Código" htmlFor="code" hint="Perdeu o celular? Digite um dos códigos de recuperação (formato xxxxx-xxxxx).">
                  <Input id="code" name="code" required autoFocus autoComplete="one-time-code" inputMode="text" maxLength={11} className="text-lg tracking-[0.2em]" />
                </Field>
                {error && (
                  <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-[oklch(0.45_0.17_25)]">
                    {error}
                  </p>
                )}
                <Button type="submit" size="lg" loading={loading}>
                  Confirmar
                </Button>
                <button
                  type="button"
                  className="cursor-pointer text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setChallenge(null);
                    setError(null);
                  }}
                >
                  Voltar
                </button>
              </form>
            </>
          )}
          {status && !challenge && (
          <>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{setup ? 'Primeiro acesso' : 'Entrar'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {setup
              ? 'Crie o acesso do painel. Você vai precisar do código de instalação (SETUP_TOKEN do .env).'
              : 'Use o e-mail e a senha do painel.'}
          </p>

          <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
            {setup && (
              <Field label="Código de instalação" htmlFor="setupToken">
                <Input id="setupToken" name="setupToken" required autoComplete="off" />
              </Field>
            )}
            <Field label="E-mail" htmlFor="email">
              <Input id="email" name="email" type="email" required autoComplete="username" inputMode="email" />
            </Field>
            <Field
              label="Senha"
              htmlFor="password"
              hint={setup ? 'Mín. 10 caracteres, com 3 destes: minúscula, maiúscula, número e símbolo.' : undefined}
            >
              <Input id="password" name="password" type="password" required autoComplete={setup ? 'new-password' : 'current-password'} />
            </Field>
            {setup && (
              <Field label="Confirmar senha" htmlFor="confirm">
                <Input id="confirm" name="confirm" type="password" required autoComplete="new-password" />
              </Field>
            )}
            {error && (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-[oklch(0.45_0.17_25)]">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" loading={loading}>
              {setup ? 'Criar acesso' : 'Entrar'}
            </Button>
          </form>
          </>
          )}
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
