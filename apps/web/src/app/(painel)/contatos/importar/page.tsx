'use client';

import { ArrowLeft, CheckCircle2, Download, FileUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { formatPhone } from '@/components/contact-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { api } from '@/lib/api';
import type { ImportReport } from '@/lib/types';
import { fmtInt } from '@/lib/utils';

const SAMPLE = 'nome;telefone;tags;opt_in\nMaria Souza;(11) 98888-7777;VIP|comprou árabe;sim\nJoão Lima;21977776666;comprou suplemento;não\n';

/** CSV salvo pelo Excel no Windows costuma vir em Windows-1252, não UTF-8. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/70 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone ?? ''}`}>{fmtInt(value)}</p>
    </div>
  );
}

export default function ImportarPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState('');
  const [defaultTags, setDefaultTags] = useState('');
  const [allOptIn, setAllOptIn] = useState(false);
  const [source, setSource] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [loading, setLoading] = useState<'check' | 'import' | null>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast.error('Arquivo acima de 5 MB. Divida em partes.');
    setFile(f);
    setCsv(await readText(f));
    setReport(null);
  }

  async function run(dryRun: boolean) {
    setLoading(dryRun ? 'check' : 'import');
    try {
      const r = await api<ImportReport>('/contacts/import', {
        method: 'POST',
        body: {
          csv,
          dryRun,
          allOptIn,
          optInSource: source || undefined,
          defaultTags: defaultTags.split(',').map((t) => t.trim()).filter(Boolean),
        },
      });
      setReport(r);
      if (!dryRun) {
        toast.success(`Importação concluída: ${r.created} novos, ${r.updated} atualizados.`);
        router.push('/contatos');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <Link href="/contatos" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Contatos
      </Link>
      <PageHeader
        title="Importar contatos (CSV)"
        description="Colunas aceitas: nome, telefone (obrigatória), tags (separadas por | ou ,), opt_in (sim/não), email. Separador ; ou , — do jeito que o Excel salvar."
        actions={
          <Button variant="outline" onClick={() => download('modelo-contatos.csv', SAMPLE)}>
            <Download /> Baixar modelo
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card>
          <CardContent className="grid gap-4 pt-5">
            <label className="grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center hover:bg-muted/50">
              <FileUp className="size-6 text-muted-foreground" />
              <span className="text-sm font-semibold">{file ? file.name : 'Escolher arquivo .csv'}</span>
              <span className="text-xs text-muted-foreground">até 5 MB · 20 mil linhas</span>
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <Field label="Tags para todos (opcional)" htmlFor="defaultTags" hint="Separadas por vírgula. Ex.: feira novembro, loja centro">
              <Input id="defaultTags" value={defaultTags} onChange={(e) => setDefaultTags(e.target.value)} />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={allOptIn} onChange={(e) => setAllOptIn(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
              <span>
                Todos desta lista autorizaram receber marketing
                <span className="block text-xs text-muted-foreground">Se não marcar, vale a coluna opt_in de cada linha.</span>
              </span>
            </label>
            <Field label="Origem do consentimento" htmlFor="source" hint="Obrigatória quando há opt-in. Fica registrada em cada contato (LGPD).">
              <Input id="source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="ex.: cadastro no site, ficha da loja física" />
            </Field>
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              Quem já pediu para sair <strong>não</strong> é reativado pela importação, e um opt-in existente nunca é removido.
            </p>
            <Button onClick={() => run(true)} loading={loading === 'check'} disabled={!csv}>
              Analisar arquivo
            </Button>
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          {!report && (
            <Card className="grid place-items-center border-dashed p-10 text-center text-sm text-muted-foreground">
              Escolha o arquivo e clique em “Analisar”. Nada é gravado até você confirmar.
            </Card>
          )}
          {report && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Resultado da análise</CardTitle>
                  <CardDescription>
                    Colunas reconhecidas:{' '}
                    {Object.entries(report.columns)
                      .filter(([, v]) => v)
                      .map(([k, v]) => `${k} = “${v}”`)
                      .join(' · ')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Linhas no arquivo" value={report.totalLines} />
                    <Stat label="Novos" value={report.created} tone="text-success" />
                    <Stat label="Já existentes" value={report.updated} />
                    <Stat label="Rejeitadas" value={report.rejected.length} tone={report.rejected.length ? 'text-destructive' : ''} />
                  </div>
                  <p className="text-sm">
                    <strong>{fmtInt(report.optInMarked)}</strong> receberão opt-in agora.
                    {report.skippedOptOut > 0 && (
                      <>
                        {' '}
                        <strong>{fmtInt(report.skippedOptOut)}</strong> estavam marcados como opt-in no arquivo, mas já tinham pedido para sair e continuam fora.
                      </>
                    )}
                  </p>
                  {report.valid > 0 && (
                    <Button onClick={() => run(false)} loading={loading === 'import'} className="justify-self-start">
                      <CheckCircle2 /> Importar {fmtInt(report.valid)} contato(s)
                    </Button>
                  )}
                </CardContent>
              </Card>

              {report.preview.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Prévia (primeiras linhas)</CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="py-1.5 font-medium">Linha</th>
                          <th className="font-medium">Nome</th>
                          <th className="font-medium">Telefone</th>
                          <th className="font-medium">Tags</th>
                          <th className="font-medium">Opt-in</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {report.preview.map((r) => (
                          <tr key={r.line}>
                            <td className="py-1.5 tabular-nums text-muted-foreground">{r.line}</td>
                            <td>{r.name ?? '—'}</td>
                            <td className="tabular-nums">{formatPhone(r.phone)}</td>
                            <td className="text-xs">{r.tags.join(', ') || '—'}</td>
                            <td>{r.optIn ? <Badge tone="success">sim</Badge> : <Badge>não</Badge>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}

              {report.rejected.length > 0 && (
                <Card>
                  <CardHeader className="flex-row items-center justify-between">
                    <CardTitle>Linhas rejeitadas ({fmtInt(report.rejected.length)})</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        download(
                          'linhas-rejeitadas.csv',
                          'linha;valor;motivo\n' + report.rejected.map((r) => `${r.line};"${r.value.replaceAll('"', '""')}";${r.reason}`).join('\n'),
                        )
                      }
                    >
                      <Download /> Baixar relatório
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <ul className="max-h-80 divide-y overflow-y-auto text-sm">
                      {report.rejected.slice(0, 200).map((r) => (
                        <li key={r.line} className="flex gap-3 py-1.5">
                          <span className="w-14 shrink-0 tabular-nums text-muted-foreground">linha {r.line}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.value}</span>
                          <span className="text-xs text-destructive">{r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
