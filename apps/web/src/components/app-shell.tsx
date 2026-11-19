'use client';

import { BellRing, Ellipsis, FileText, Heart, Inbox, LayoutDashboard, LogOut, Megaphone, MessageSquareText, Package, Phone, Plug, ShieldCheck, Sparkles, Truck, UserCog, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark, BrandName } from '@/components/brand';
import { api } from '@/lib/api';
import type { AuthStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Visão geral', short: 'Início', icon: LayoutDashboard, mobile: true },
  { href: '/inbox', label: 'Inbox', short: 'Inbox', icon: Inbox, mobile: true },
  { href: '/contatos', label: 'Contatos', short: 'Contatos', icon: Users, mobile: true },
  { href: '/campanhas', label: 'Campanhas', short: 'Campanhas', icon: Megaphone, mobile: true },
  { href: '/cobranca', label: 'Cobrança', short: 'Cobrança', icon: Wallet, mobile: false },
  { href: '/avisos-pedido', label: 'Avisos de pedido', short: 'Avisos', icon: BellRing, mobile: false },
  { href: '/relacionamento', label: 'Relacionamento', short: 'Relacionamento', icon: Heart, mobile: false },
  { href: '/fornecedores', label: 'Fornecedores', short: 'Fornecedores', icon: Truck, mobile: false },
  { href: '/numeros', label: 'Números', short: 'Números', icon: Phone, mobile: false },
  { href: '/templates', label: 'Templates', short: 'Templates', icon: FileText, mobile: false },
  { href: '/respostas-rapidas', label: 'Respostas rápidas', short: 'Respostas', icon: MessageSquareText, mobile: false },
  { href: '/produtos', label: 'Produtos', short: 'Produtos', icon: Package, mobile: false },
  { href: '/bot', label: 'Bot de IA', short: 'Bot', icon: Sparkles, mobile: false },
  { href: '/equipe', label: 'Equipe', short: 'Equipe', icon: UserCog, mobile: false, adminOnly: true },
  { href: '/integracao', label: 'Integração com o site', short: 'Integração', icon: Plug, mobile: false, adminOnly: true },
  { href: '/seguranca', label: 'Segurança', short: 'Segurança', icon: ShieldCheck, mobile: false },
] as const;

type NavItem = (typeof NAV)[number];
const visibleFor = (role: string) => (n: NavItem) => !('adminOnly' in n) || role === 'ADMIN';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthStatus['user']>(null);
  // A inbox ocupa a tela inteira (lista + chat), sem margens.
  const fullBleed = pathname.startsWith('/inbox');
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    api<AuthStatus>('/auth/status')
      .then((s) => {
        if (!s.user) router.replace(`/login?voltar=${encodeURIComponent(pathname)}`);
        else setUser(s.user);
      })
      .catch(() => router.replace('/login'));
  }, [router, pathname]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  if (!user) {
    return <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground">Carregando…</div>;
  }
  const nav = NAV.filter(visibleFor(user.role));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      {/* Barra lateral (computador) */}
      <aside className="sticky top-0 hidden h-dvh flex-col bg-sidebar px-3 py-5 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3 px-2">
          <BrandMark />
          <BrandName />
        </div>
        <nav className="mt-8 grid gap-1" aria-label="Principal">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive(pathname, href) ? 'bg-white/12 text-white' : 'text-sidebar-muted hover:bg-white/6 hover:text-white',
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-white/10 px-2 pt-4">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="truncate text-xs text-sidebar-muted" title={user.email}>
            {user.email}
          </p>
          <button
            onClick={logout}
            className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-sidebar-muted hover:text-white"
          >
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      </aside>

      {/* Topo (celular) */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-8 text-base" />
          <span className="font-display text-base font-semibold">Oliver Hub</span>
        </div>
        <button onClick={logout} className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground" aria-label={`Sair (${user.name})`}>
          <span className="max-w-28 truncate">{user.name}</span> · <LogOut className="size-4" /> Sair
        </button>
      </header>

      <main className={cn('min-w-0', fullBleed ? 'lg:h-dvh' : 'px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8')}>{children}</main>

      {/* Navegação inferior (celular) */}
      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {NAV.filter((n) => n.mobile).map(({ href, short, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold',
              isActive(pathname, href) ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" />
            {short}
          </Link>
        ))}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-1 py-2.5 text-[11px] font-semibold',
            moreOpen || nav.some((n) => !n.mobile && isActive(pathname, n.href)) ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Ellipsis className="size-5" />
          Mais
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-[calc(4.25rem+env(safe-area-inset-bottom))] right-3 w-56 rounded-xl border bg-card p-1.5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {nav.filter((n) => !n.mobile).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMoreOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium',
                  isActive(pathname, href) ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted',
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
