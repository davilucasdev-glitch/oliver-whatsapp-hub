'use client';

import { CalendarClock, Package, Rocket, Save, Search, ShieldCheck, TriangleAlert, Users, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import { HOURS } from '@/components/campaigns/campaign-bits';
import { displayName, formatPhone } from '@/components/contact-bits';
import { QualityBadge, WhatsAppBubble } from '@/components/status';
import { TagPicker } from '@/components/tag-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { api, fetcher } from '@/lib/api';
import type {
  CampaignDetail,
  CampaignEstimate,
  CampaignPreview,
  CampaignSegment,
  PhoneNumber,
  ProductItem,
  Tag,
  Template,
  VariableMap,
  VariableSource,
} from '@/lib/types';
import { cn, fmtInt, fmtMoney } from '@/lib/utils';

type Initial = CampaignDetail['campaign'];

const SOURCE_LABEL: Record<string, string> = {
  firstName: 'Primeiro nome do cliente',
  fullName: 'Nome completo do cliente',
  text: 'Texto fixo',
  'product:name': 'Produto: nome',
  'product:price': 'Produto: preço',
};

const MEDIA_LABEL: Record<string, string> = { IMAGE: 'imagem', VIDEO: 'vídeo', DOCUMENT: 'documento' };

function shapeOf(t: Template | undefined) {
  const header = t?.components?.find((c) => c.type === 'HEADER');
  const media = header?.format && header.format !== 'TEXT' ? header.format : null;
  return { headerVars: media ? 0 : t?.variables.header ?? 0, bodyVars: t?.variables.body ?? 0, headerMedia: media };
}

function defaultVars(n: number, firstIsName: boolean): VariableSource[] {
  return Array.from({ length: n }, (_, i) => (i === 0 && firstIsName ? { source: 'firstName', fallback: 'cliente' } : { source: 'text', value: '' }));
}

function sourceKey(v: VariableSource) {
  return v.source === 'product' ? `product:${v.field}` : v.source;
}

function ProductPicker({ productId, onPick }: { productId: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const { data: chosen } = useSWR<{ product: ProductItem }>(productId ? `/products/${productId}` : null, fetcher);
  const { data } = useSWR<{ products: ProductItem[] }>(q.trim().length >= 2 ? `/products?q=${encodeURIComponent(q.trim())}&pageSize=6` : null, fetcher);
  if (productId && chosen) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span className="min-w-0 truncate">
          <Package className="mr-1.5 inline size-3.5 text-muted-foreground" />
          {chosen.product.name} · {fmtMoney(chosen.product.price)}
        </span>
        <button type="button" onClick={() => onPick('')} className="cursor-pointer text-muted-foreground hover:text-foreground" aria-label="Trocar produto">
          <X className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto do catálogo…" className="pl-9" aria-label="Buscar produto" />
      </div>
      {data?.products.map((p) => (
        <button
          type="button"
          key={p.id}
          onClick={() => {
            onPick(p.id);
            setQ('');
          }}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm hover:bg-muted"
        >
          <span className="min-w-0 truncate">{p.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtMoney(p.price)}</span>
        </button>
      ))}
      {data && data.products.length === 0 && <p className="text-xs text-muted-foreground">Nenhum produto encontrado.</p>}
    </div>
  );
}

function VariableEditor({ label, value, onChange }: { label: string; value: VariableSource; onChange: (v: VariableSource) => void }) {
  const key = sourceKey(value);
  const id = label.replace(/\W/g, '');
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <Field label={label} htmlFor={`src-${id}`}>
        <Select
          id={`src-${id}`}
          value={key}
          onChange={(e) => {
            const k = e.target.value;
            if (k === 'firstName' || k === 'fullName') onChange({ source: k, fallback: 'cliente' });
            else if (k === 'text') onChange({ source: 'text', value: '' });
            else onChange({ source: 'product', productId: value.source === 'product' ? value.productId : '', field: k === 'product:price' ? 'price' : 'name' });
          }}
        >
          {Object.entries(SOURCE_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {(value.source === 'firstName' || value.source === 'fullName') && (
        <Field label="Se o contato não tiver nome" htmlFor={`fb-${id}`}>
          <Input id={`fb-${id}`} value={value.fallback} maxLength={60} onChange={(e) => onChange({ ...value, fallback: e.target.value })} />
        </Field>
      )}
      {value.source === 'text' && (
        <Input value={value.value} maxLength={200} onChange={(e) => onChange({ ...value, value: e.target.value })} placeholder="ex.: Lattafa" aria-label={`${label}: texto`} />
      )}
      {value.source === 'product' && <ProductPicker productId={value.productId} onPick={(productId) => onChange({ ...value, productId })} />}
    </div>
  );
}

export function CampaignForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const { data: nums } = useSWR<{ numbers: PhoneNumber[] }>('/numbers', fetcher);
  const { data: tpls } = useSWR<{ templates: Template[] }>('/templates?status=APPROVED', fetcher);
  const { data: tagData } = useSWR<{ tags: Tag[] }>('/tags', fetcher);

  const [name, setName] = useState(initial?.name ?? '');
  const [numberChoice, setNumberId] = useState(initial?.phoneNumberId ?? '');
  const [templateId, setTemplateId] = useState(initial?.templateId ?? '');
  const [vars, setVars] = useState<VariableMap>(initial?.variables ?? { header: [], body: [] });
  const [mediaUrl, setMediaUrl] = useState(initial?.headerMediaUrl ?? '');
  const [segment, setSegment] = useState<CampaignSegment>(initial?.segment ?? { tagsAny: [], tagsAll: [], excludeTags: [] });
  const [when, setWhen] = useState<'now' | 'schedule'>(initial?.scheduledLocal ? 'schedule' : 'now');
  const [scheduledLocal, setScheduledLocal] = useState(initial?.scheduledLocal ?? '');
  const [windowStart, setWindowStart] = useState(initial?.windowStartHour ?? 9);
  const [windowEnd, setWindowEnd] = useState(initial?.windowEndHour ?? 20);
  const [estimate, setEstimate] = useState<CampaignEstimate | null>(null);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewContactId, setPreviewContactId] = useState<string>('');
  const [saving, setSaving] = useState<'draft' | 'start' | null>(null);
  const [confirm, setConfirm] = useState(false);

  const numbers = useMemo(() => (nums?.numbers ?? []).filter((n) => n.isActive && n.role !== 'ATTENDANCE'), [nums]);
  // número padrão: o primeiro que pode fazer campanha
  const numberId = numberChoice || numbers[0]?.id || '';
  const number = numbers.find((n) => n.id === numberId);
  const templates = (tpls?.templates ?? []).filter((t) => !number || t.wabaId === number.wabaId);
  const template = templates.find((t) => t.id === templateId);
  const shape = shapeOf(template);
  const tags = tagData?.tags ?? [];

  function pickTemplate(id: string) {
    setTemplateId(id);
    const s = shapeOf(templates.find((t) => t.id === id));
    setVars({ header: defaultVars(s.headerVars, false), body: defaultVars(s.bodyVars, true) });
  }

  const segKey = JSON.stringify(segment);
  // estimativa do público (com atraso para não chamar a cada tecla)
  useEffect(() => {
    const t = setTimeout(() => {
      api<CampaignEstimate>('/campaigns/estimate', {
        method: 'POST',
        body: { segment: JSON.parse(segKey) as CampaignSegment, phoneNumberId: numberId || undefined, windowStartHour: windowStart, windowEndHour: windowEnd },
      })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 350);
    return () => clearTimeout(t);
  }, [segKey, numberId, windowStart, windowEnd]);

  const varsKey = JSON.stringify(vars);
  useEffect(() => {
    if (!templateId) return;
    const t = setTimeout(() => {
      api<CampaignPreview>('/campaigns/preview', {
        method: 'POST',
        body: {
          templateId,
          variables: JSON.parse(varsKey) as VariableMap,
          headerMediaUrl: mediaUrl || null,
          segment: JSON.parse(segKey) as CampaignSegment,
          contactId: previewContactId || undefined,
        },
      })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: Error) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [templateId, varsKey, mediaUrl, segKey, previewContactId]);

  function payload() {
    return {
      name,
      phoneNumberId: numberId,
      templateId,
      segment,
      variables: vars,
      headerMediaUrl: shape.headerMedia ? mediaUrl || null : null,
      scheduledAt: when === 'schedule' ? scheduledLocal || null : null,
      windowStartHour: windowStart,
      windowEndHour: windowEnd,
    };
  }

  async function save(start: boolean) {
    if (when === 'schedule' && !scheduledLocal) return toast.error('Escolha a data e a hora do agendamento.');
    setSaving(start ? 'start' : 'draft');
    try {
      const res = initial
        ? await api<{ campaign: { id: string } }>(`/campaigns/${initial.id}`, { method: 'PUT', body: payload() })
        : await api<{ campaign: { id: string } }>('/campaigns', { method: 'POST', body: payload() });
      const id = res.campaign.id;
      if (start) {
        const r = await api<{ campaign: { status: string } }>(`/campaigns/${id}/start`, { method: 'POST' });
        toast.success(r.campaign.status === 'SCHEDULED' ? 'Campanha agendada' : 'Campanha iniciada');
      } else {
        toast.success('Rascunho salvo');
      }
      router.push(`/campanhas/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setConfirm(false);
    } finally {
      setSaving(null);
    }
  }

  const ready = name.trim().length >= 2 && numberId && template && !previewError;
  const scheduleOutside = when === 'schedule' && scheduledLocal && (() => {
    const h = Number(scheduledLocal.slice(11, 13));
    return h < windowStart || h >= windowEnd;
  })();

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid min-w-0 content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle>1. Campanha</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome (só para você)" htmlFor="c-name">
              <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Black Friday árabes" maxLength={120} />
            </Field>
            <Field
              label="Enviar pelo número"
              htmlFor="c-number"
              hint={number ? `Ritmo: ${number.sendRatePerMinute} mensagens/min · limite ${fmtInt(number.dailyConversationLimit)} conversas/dia` : undefined}
            >
              <Select id="c-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
                {numbers.length === 0 && <option value="">Nenhum número de campanha</option>}
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.displayName} {n.displayPhone ? `(${n.displayPhone})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {number && (number.qualityRating !== 'HIGH' || number.campaignsPaused) && (
              <p className="flex items-center gap-2 text-sm sm:col-span-2">
                <QualityBadge rating={number.qualityRating} />
                {number.campaignsPaused ? 'As campanhas deste número estão pausadas (libere em Números).' : number.qualityRating === 'MEDIUM' ? 'Ritmo reduzido pela metade.' : ''}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Mensagem</CardTitle>
            <CardDescription>Só templates aprovados pela Meta. Personalizar com o nome evita mensagens idênticas em massa.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Template" htmlFor="c-tpl">
              <Select id="c-tpl" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                <option value="">Escolha…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.category === 'MARKETING' ? 'marketing' : 'utilidade'}, {t.language})
                  </option>
                ))}
              </Select>
            </Field>
            {tpls && templates.length === 0 && (
              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Nenhum template aprovado para este número. Sincronize ou crie um em Templates.</p>
            )}
            {shape.headerMedia && (
              <Field
                label={`Link público da ${MEDIA_LABEL[shape.headerMedia]} do cabeçalho`}
                htmlFor="c-media"
                hint="A Meta baixa o arquivo deste link (https). Use uma imagem hospedada no seu site ou no Bling."
              >
                <Input id="c-media" type="url" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" />
              </Field>
            )}
            {vars.header.map((v, i) => (
              <VariableEditor key={`h${i}`} label={`Cabeçalho {{${i + 1}}}`} value={v} onChange={(nv) => setVars((o) => ({ ...o, header: Object.assign([...o.header], { [i]: nv }) }))} />
            ))}
            {vars.body.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {vars.body.map((v, i) => (
                  <VariableEditor key={`b${i}`} label={`Variável {{${i + 1}}}`} value={v} onChange={(nv) => setVars((o) => ({ ...o, body: Object.assign([...o.body], { [i]: nv }) }))} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Público</CardTitle>
            <CardDescription>Só recebe quem deu opt-in, não pediu para sair e não recebeu campanha nos últimos {estimate?.minDaysBetween ?? 7} dias.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Com qualquer uma destas tags</span>
              <TagPicker tags={tags} selected={segment.tagsAny} onChange={(ids) => setSegment((s) => ({ ...s, tagsAny: ids }))} />
              <span className="text-xs text-muted-foreground">Nenhuma marcada = todos os contatos.</span>
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Que tenham todas estas tags</span>
              <TagPicker tags={tags} selected={segment.tagsAll} onChange={(ids) => setSegment((s) => ({ ...s, tagsAll: ids }))} />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Excluir quem tem</span>
              <TagPicker tags={tags} selected={segment.excludeTags} onChange={(ids) => setSegment((s) => ({ ...s, excludeTags: ids }))} />
            </div>
            <Field label="Sem falar com a loja há pelo menos (dias)" htmlFor="c-inactive" hint="Vazio = qualquer um. Ex.: 60 para reativar clientes sumidos.">
              <Input
                id="c-inactive"
                type="number"
                min={1}
                max={3650}
                className="w-32"
                value={segment.inactiveDays ?? ''}
                onChange={(e) => setSegment((s) => ({ ...s, inactiveDays: e.target.value ? Number(e.target.value) : undefined }))}
              />
            </Field>
            {estimate && (
              <div className="grid gap-2 rounded-lg bg-muted/60 p-3 text-sm">
                <p className="flex items-center gap-2 font-semibold">
                  <Users className="size-4" /> {fmtInt(estimate.eligible)} de {fmtInt(estimate.total)} contatos vão receber
                </p>
                {estimate.excluded
                  .filter((e) => e.count > 0)
                  .map((e) => (
                    <p key={e.reason} className="text-muted-foreground">
                      − {fmtInt(e.count)} · {e.label}
                    </p>
                  ))}
                {estimate.timing && estimate.eligible > 0 && (
                  <p className="text-muted-foreground">
                    Tempo estimado:{' '}
                    {estimate.timing.days <= 1
                      ? `cerca de ${estimate.timing.minutesFirstDay < 60 ? `${estimate.timing.minutesFirstDay} min` : `${Math.ceil(estimate.timing.minutesFirstDay / 60)} h`}`
                      : `${estimate.timing.days} dias (até ${fmtInt(estimate.timing.perDay)} por dia, pelo ${estimate.timing.limitedBy})`}
                    , a {estimate.timing.ratePerMinute}/min.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Quando</CardTitle>
            <CardDescription>Horário de Brasília. Fora da janela o envio para e continua no dia seguinte.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Quando enviar">
              {(['now', 'schedule'] as const).map((w) => (
                <button
                  type="button"
                  key={w}
                  role="radio"
                  aria-checked={when === w}
                  onClick={() => setWhen(w)}
                  className={cn('cursor-pointer rounded-md border px-3 py-2 text-sm font-semibold', when === w ? 'border-primary bg-secondary text-secondary-foreground' : 'bg-card hover:bg-muted')}
                >
                  {w === 'now' ? 'Começar assim que eu iniciar' : 'Agendar'}
                </button>
              ))}
            </div>
            {when === 'schedule' && (
              <Field label="Data e hora" htmlFor="c-when">
                <Input id="c-when" type="datetime-local" value={scheduledLocal} onChange={(e) => setScheduledLocal(e.target.value)} className="w-60" />
              </Field>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Janela: das" htmlFor="c-ws">
                <Select id="c-ws" value={windowStart} onChange={(e) => setWindowStart(Number(e.target.value))} className="w-24">
                  {HOURS.slice(0, -1).map((h) => (
                    <option key={h} value={h}>
                      {h}h
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="até" htmlFor="c-we">
                <Select id="c-we" value={windowEnd} onChange={(e) => setWindowEnd(Number(e.target.value))} className="w-24">
                  {HOURS.slice(1).map((h) => (
                    <option key={h} value={h}>
                      {h}h
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="pb-2.5 text-xs text-muted-foreground">Nunca de madrugada: só entre 8h e 21h.</p>
            </div>
            {scheduleOutside && (
              <p className="flex items-center gap-2 text-sm text-[oklch(0.45_0.11_60)]">
                <TriangleAlert className="size-4" /> O horário agendado está fora da janela: o envio começa quando a janela abrir.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setConfirm(true)} disabled={!ready || !estimate?.eligible} loading={saving === 'start'}>
            {when === 'schedule' ? <CalendarClock /> : <Rocket />}
            {when === 'schedule' ? 'Salvar e agendar' : 'Salvar e iniciar'}
          </Button>
          <Button variant="outline" onClick={() => void save(false)} disabled={!ready} loading={saving === 'draft'}>
            <Save /> Salvar rascunho
          </Button>
        </div>
      </div>

      <div className="grid content-start gap-4 xl:sticky xl:top-8">
        <Card>
          <CardHeader>
            <CardTitle>Pré-visualização</CardTitle>
            <CardDescription>
              {!templateId || !preview ? 'Como o cliente vai receber.' : preview.contact ? `Como ${displayName(preview.contact)} vai receber.` : 'Com dados de exemplo (nenhum contato apto no público).'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {!templateId && <p className="text-sm text-muted-foreground">Escolha um template.</p>}
            {previewError && <p className="rounded-md bg-danger-soft p-3 text-sm text-[oklch(0.45_0.17_25)]">{previewError}</p>}
            {templateId && preview && !previewError && (
              <>
                {preview.headerMedia && (
                  <div className="grid h-32 place-items-center overflow-hidden rounded-lg bg-muted text-xs text-muted-foreground">
                    {preview.headerMedia.url && preview.headerMedia.format === 'IMAGE' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview.headerMedia.url} alt="Imagem do cabeçalho" className="h-full w-full object-cover" />
                    ) : (
                      `[${MEDIA_LABEL[preview.headerMedia.format] ?? 'mídia'} do cabeçalho]`
                    )}
                  </div>
                )}
                <WhatsAppBubble text={preview.text} />
              </>
            )}
            {estimate && estimate.sample.length > 1 && templateId && (
              <Field label="Ver como outro contato" htmlFor="c-prev">
                <Select id="c-prev" value={previewContactId} onChange={(e) => setPreviewContactId(e.target.value)}>
                  <option value="">{estimate.sample[0] ? displayName(estimate.sample[0]) : 'Primeiro do público'}</option>
                  {estimate.sample.slice(1).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name ? `${displayName(c)} · ${formatPhone(c.phone)}` : formatPhone(c.phone)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </CardContent>
        </Card>
        <Card className="p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-4 text-primary" /> Proteções automáticas
          </p>
          <ul className="mt-2 grid gap-1.5 text-muted-foreground">
            <li>• Ritmo controlado por número (reduz sozinho se a qualidade cair).</li>
            <li>• Para se a qualidade ficar BAIXA, se a Meta acusar spam ou se o template for pausado.</li>
            <li>• Pausa a campanha se mais de 30% dos envios falharem.</li>
            <li>• Usa no máximo 90% do limite diário do número.</li>
            <li>• Quem responder SAIR ou tocar em &quot;Parar promoções&quot; nunca mais recebe.</li>
          </ul>
        </Card>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{when === 'schedule' ? 'Agendar campanha?' : 'Iniciar campanha?'}</DialogTitle>
            <DialogDescription>
              {fmtInt(estimate?.eligible ?? 0)} contatos vão receber o template <b>{template?.name}</b> pelo número <b>{number?.displayName}</b>
              {when === 'schedule' && scheduledLocal ? `, a partir de ${scheduledLocal.slice(8, 10)}/${scheduledLocal.slice(5, 7)} às ${scheduledLocal.slice(11)}` : ''}, entre {windowStart}h e {windowEnd}h. Você pode pausar a qualquer momento.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Voltar
            </Button>
            <Button onClick={() => void save(true)} loading={saving === 'start'}>
              {when === 'schedule' ? 'Agendar' : 'Iniciar agora'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
