'use client';

import { ArrowLeft, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { WhatsAppBubble } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { api } from '@/lib/api';

const OPT_OUT = 'Parar promoções';

function vars(text: string): number[] {
  return [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

function fill(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, i: string) => values[Number(i) - 1] || `{{${i}}}`);
}

export default function NovoTemplatePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>('MARKETING');
  const [header, setHeader] = useState('');
  const [headerExample, setHeaderExample] = useState('');
  const [body, setBody] = useState('Oi {{1}}! Chegaram novidades de {{2}} aqui na Oliver 💜 Quer que eu te mostre?');
  const [examples, setExamples] = useState<string[]>(['Maria', 'perfumes árabes']);
  const [footer, setFooter] = useState('Oliver Cosmetics');
  const [quick, setQuick] = useState<string[]>(['Quero ver']);
  const [addOptOut, setAddOptOut] = useState(true);
  const [saving, setSaving] = useState(false);

  const bodyVars = useMemo(() => vars(body), [body]);
  const headerVars = useMemo(() => vars(header), [header]);
  const sequential = bodyVars.every((v, i) => v === i + 1);
  const buttons = [...quick.filter(Boolean), ...(category === 'MARKETING' && addOptOut ? [OPT_OUT] : [])];

  const preview = [
    header && `*${fill(header, [headerExample])}*`,
    fill(body, examples),
    footer && `_${footer}_`,
    buttons.length ? buttons.map((b) => `[ ${b} ]`).join(' ') : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const problems: string[] = [];
  if (name && !/^[a-z0-9_]+$/.test(name)) problems.push('Nome: só letras minúsculas, números e _ (sem espaços ou acentos).');
  if (!sequential) problems.push('As variáveis do texto precisam ser {{1}}, {{2}}, {{3}}… em sequência.');
  if (bodyVars.some((_, i) => !examples[i]?.trim())) problems.push('Preencha um exemplo para cada variável (a Meta exige).');
  if (headerVars.length > 1) problems.push('O cabeçalho aceita no máximo 1 variável.');
  if (headerVars.length === 1 && !headerExample.trim()) problems.push('Preencha o exemplo da variável do cabeçalho.');
  if (buttons.length > 3) problems.push('No máximo 3 botões de resposta rápida.');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problems.length) return toast.error(problems[0]);
    setSaving(true);
    try {
      await api('/templates', {
        method: 'POST',
        body: {
          name,
          category,
          language: 'pt_BR',
          header: header || undefined,
          headerExample: headerExample || undefined,
          body,
          bodyExamples: examples.slice(0, bodyVars.length),
          footer: footer || undefined,
          quickReplies: quick.filter(Boolean),
          addOptOutButton: addOptOut,
        },
      });
      toast.success('Template enviado para aprovação da Meta. Costuma levar de minutos a algumas horas.');
      router.push('/templates');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Link href="/templates" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Templates
      </Link>
      <PageHeader title="Novo template" description="Use variáveis como {{1}} e {{2}} para personalizar (nome, produto). Mensagens personalizadas reduzem o risco de bloqueio." />

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardContent className="grid gap-5 pt-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Nome interno" htmlFor="name" hint="ex.: novidades_arabes_nov">
                <Input id="name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '_'))} required />
              </Field>
              <Field
                label="Categoria"
                htmlFor="category"
                hint={category === 'MARKETING' ? 'Promoções e novidades.' : 'Avisos de pedido, entrega, conta (sem promoção).'}
              >
                <Select id="category" value={category} onChange={(e) => setCategory(e.target.value as 'MARKETING' | 'UTILITY')}>
                  <option value="MARKETING">Marketing</option>
                  <option value="UTILITY">Utilidade</option>
                </Select>
              </Field>
            </div>

            <Field label="Cabeçalho (opcional)" htmlFor="header" hint="Até 60 caracteres, no máximo 1 variável.">
              <Input id="header" value={header} maxLength={60} onChange={(e) => setHeader(e.target.value)} />
            </Field>
            {headerVars.length === 1 && (
              <Field label="Exemplo para {{1}} do cabeçalho" htmlFor="headerExample">
                <Input id="headerExample" value={headerExample} onChange={(e) => setHeaderExample(e.target.value)} />
              </Field>
            )}

            <Field label="Texto da mensagem" htmlFor="body" hint={`${body.length}/1024 caracteres`}>
              <Textarea id="body" value={body} maxLength={1024} onChange={(e) => setBody(e.target.value)} rows={5} required />
            </Field>

            {bodyVars.length > 0 && (
              <div className="grid gap-3 rounded-lg bg-muted/60 p-3">
                <p className="text-sm font-medium">Exemplos das variáveis (só para a Meta aprovar)</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {bodyVars.map((v, i) => (
                    <Field key={v} label={`{{${v}}}`} htmlFor={`ex${v}`}>
                      <Input
                        id={`ex${v}`}
                        value={examples[i] ?? ''}
                        onChange={(e) => setExamples((old) => Object.assign([...old], { [i]: e.target.value }))}
                        placeholder={i === 0 ? 'nome do cliente' : 'produto'}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            )}

            <Field label="Rodapé (opcional)" htmlFor="footer">
              <Input id="footer" value={footer} maxLength={60} onChange={(e) => setFooter(e.target.value)} />
            </Field>

            <div className="grid gap-2">
              <p className="text-sm font-medium">Botões de resposta rápida</p>
              {quick.map((q, i) => (
                <div key={i} className="flex gap-2">
                  <Input value={q} maxLength={25} onChange={(e) => setQuick((old) => Object.assign([...old], { [i]: e.target.value }))} />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setQuick((old) => old.filter((_, j) => j !== i))} aria-label="Remover botão">
                    <X />
                  </Button>
                </div>
              ))}
              {buttons.length < 3 && (
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setQuick((old) => [...old, ''])}>
                  <Plus /> Adicionar botão
                </Button>
              )}
              {category === 'MARKETING' && (
                <label className="mt-1 flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={addOptOut} onChange={(e) => setAddOptOut(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
                  <span>
                    Incluir o botão “{OPT_OUT}”
                    <span className="block text-xs text-muted-foreground">Recomendado: quem toca nele é descadastrado automaticamente, e isso evita denúncias.</span>
                  </span>
                </label>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid content-start gap-4 lg:sticky lg:top-8">
          <Card>
            <CardHeader>
              <CardTitle>Pré-visualização</CardTitle>
            </CardHeader>
            <CardContent>
              <WhatsAppBubble text={preview} />
            </CardContent>
          </Card>
          {problems.length > 0 && (
            <ul className="grid gap-1 rounded-lg bg-warning-soft p-3 text-sm">
              {problems.map((p) => (
                <li key={p}>• {p}</li>
              ))}
            </ul>
          )}
          <Button type="submit" size="lg" loading={saving} disabled={!name}>
            Enviar para aprovação
          </Button>
        </div>
      </form>
    </>
  );
}
