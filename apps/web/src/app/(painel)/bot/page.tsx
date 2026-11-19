'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { BotLogs } from '@/components/bot/bot-logs';
import { BotSettingsPanel } from '@/components/bot/bot-settings';
import { KnowledgeEditor } from '@/components/bot/knowledge-editor';
import { Simulator } from '@/components/bot/simulator';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'simulador', label: 'Simulador' },
  { key: 'conhecimento', label: 'Base de conhecimento' },
  { key: 'configuracoes', label: 'Configurações' },
  { key: 'registros', label: 'Registros' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function BotContent() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('aba');
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'simulador';

  return (
    <>
      <PageHeader title="Bot de IA" description="Atende no WhatsApp com o catálogo do Bling e a base de conhecimento da Oliver, e chama a equipe quando precisa." />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => router.replace(`/bot?aba=${t.key}`, { scroll: false })}
            className={cn(
              '-mb-px cursor-pointer whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'simulador' && <Simulator />}
      {tab === 'conhecimento' && <KnowledgeEditor />}
      {tab === 'configuracoes' && <BotSettingsPanel />}
      {tab === 'registros' && <BotLogs />}
    </>
  );
}

export default function BotPage() {
  return (
    <Suspense>
      <BotContent />
    </Suspense>
  );
}
