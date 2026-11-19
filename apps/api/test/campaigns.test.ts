import { describe, expect, it } from 'vitest';
import { classifyMetaCode } from '../src/campaigns/errors.js';
import { estimateDuration, isWithinWindow, nextSlot, nextWindowStart, sendIntervalMs, skipReasonFor, validateWindow } from '../src/campaigns/rules.js';
import { buildCampaignMessage } from '../src/campaigns/service.js';
import { firstName, fullName, resolveAll, templateShape } from '../src/campaigns/variables.js';
import type { TemplateComponentDef } from '../src/whatsapp/meta-management.js';

const TZ = 'America/Sao_Paulo';
// 16/11/2026 (segunda): 12:00 UTC = 09:00 em São Paulo
const at = (iso: string) => new Date(iso);

describe('janela de envio', () => {
  it('nunca de madrugada: só entre 8h e 21h, com pelo menos 1h', () => {
    expect(validateWindow(9, 20)).toBeNull();
    expect(validateWindow(6, 20)).toMatch(/antes das 8h/);
    expect(validateWindow(9, 23)).toMatch(/depois das 21h/);
    expect(validateWindow(10, 10)).toMatch(/1 hora/);
  });

  it('respeita o fuso de São Paulo e o fim exclusivo', () => {
    expect(isWithinWindow(at('2026-11-16T12:00:00Z'), TZ, 9, 20)).toBe(true); // 09:00
    expect(isWithinWindow(at('2026-11-16T11:59:00Z'), TZ, 9, 20)).toBe(false); // 08:59
    expect(isWithinWindow(at('2026-11-16T22:59:00Z'), TZ, 9, 20)).toBe(true); // 19:59
    expect(isWithinWindow(at('2026-11-16T23:00:00Z'), TZ, 9, 20)).toBe(false); // 20:00
    expect(isWithinWindow(at('2026-11-17T05:00:00Z'), TZ, 9, 20)).toBe(false); // 02:00
  });

  it('próxima abertura: hoje se ainda não abriu, senão amanhã', () => {
    expect(nextWindowStart(at('2026-11-16T10:00:00Z'), TZ, 9).toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(nextWindowStart(at('2026-11-16T23:30:00Z'), TZ, 9).toISOString()).toBe('2026-11-17T12:00:00.000Z');
    // virada de mês
    expect(nextWindowStart(at('2026-11-30T23:30:00Z'), TZ, 9).toISOString()).toBe('2026-12-01T12:00:00.000Z');
  });
});

describe('ritmo por número', () => {
  it('reserva vagas no intervalo do ritmo (20/min = 1 a cada 3 s)', () => {
    const interval = sendIntervalMs(20);
    expect(interval).toBe(3000);
    const t0 = at('2026-11-16T15:00:00Z');
    const s1 = nextSlot(null, t0, interval, 2000);
    expect(s1?.getTime()).toBe(t0.getTime() + 3000);
    expect(nextSlot(s1, new Date(t0.getTime() + 2000), interval, 2000)).toBeNull(); // cedo demais
    // rodadas a cada 2 s: o ritmo médio continua 1 a cada 3 s (o atraso pequeno é compensado)
    let slot: Date | null = null;
    let sent = 0;
    for (let ms = 0; ms <= 60_000; ms += 2000) {
      const now = new Date(t0.getTime() + ms);
      for (;;) {
        const next = nextSlot(slot, now, interval, 2000);
        if (!next) break;
        slot = next;
        sent++;
      }
    }
    expect(sent).toBeGreaterThanOrEqual(20);
    expect(sent).toBeLessThanOrEqual(21);
  });

  it('depois de parado não solta rajada acumulada', () => {
    const t0 = at('2026-11-16T15:00:00Z');
    const old = new Date(t0.getTime() - 3_600_000);
    const s = nextSlot(old, t0, 3000, 2000);
    expect(s?.getTime()).toBe(t0.getTime() + 3000);
    expect(nextSlot(s, t0, 3000, 2000)).toBeNull();
  });

  it('estimativa: limitada pelo ritmo ou pelo limite diário', () => {
    expect(estimateDuration(1000, 20, 11, 900)).toMatchObject({ days: 2, perDay: 900, limitedBy: 'limite diário' });
    expect(estimateDuration(600, 20, 11, 20000)).toMatchObject({ days: 1, minutesFirstDay: 30, limitedBy: 'ritmo' });
    expect(estimateDuration(0, 20, 11, 9000)).toMatchObject({ days: 0, minutesFirstDay: 0 });
  });
});

describe('quem pode receber', () => {
  const now = at('2026-11-16T15:00:00Z');
  const base = { phone: '+5511988887777', optIn: true, optOut: false, lastCampaignAt: null };
  it('opt-in obrigatório, opt-out manda, frequência por contato e E.164', () => {
    expect(skipReasonFor(base, now, 7)).toBeNull();
    expect(skipReasonFor({ ...base, optIn: false }, now, 7)).toBe('sem opt-in');
    expect(skipReasonFor({ ...base, optOut: true }, now, 7)).toBe('opt-out');
    expect(skipReasonFor({ ...base, phone: '11988887777' }, now, 7)).toBe('telefone inválido');
    const sixDaysAgo = new Date(now.getTime() - 6 * 86_400_000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000);
    expect(skipReasonFor({ ...base, lastCampaignAt: sixDaysAgo }, now, 7)).toBe('frequência');
    expect(skipReasonFor({ ...base, lastCampaignAt: eightDaysAgo }, now, 7)).toBeNull();
    expect(skipReasonFor({ ...base, lastCampaignAt: sixDaysAgo }, now, 0)).toBeNull(); // 0 = sem limite
  });
});

describe('variáveis', () => {
  it('primeiro nome bonito; nomes estranhos usam o padrão', () => {
    expect(firstName('MARIA DA SILVA')).toBe('Maria');
    expect(firstName('  joão-pedro souza')).toBe('João-Pedro');
    expect(firstName('Loja123')).toBeNull();
    expect(firstName('😀')).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(fullName('ANA DE SOUZA')).toBe('Ana de Souza');
  });

  it('resolve nome, texto fixo e produto (com preço em reais)', () => {
    const products = new Map([['p1', { id: 'p1', name: 'Asad Lattafa 100ml', price: 189.9 as never, active: true }]]);
    const v = resolveAll(
      {
        header: [],
        body: [
          { source: 'firstName', fallback: 'cliente' },
          { source: 'product', productId: 'p1', field: 'name' },
          { source: 'product', productId: 'p1', field: 'price' },
          { source: 'text', value: 'BLACK10' },
        ],
      },
      { name: null },
      products,
    );
    expect(v.body).toEqual(['cliente', 'Asad Lattafa 100ml', 'R$ 189,90', 'BLACK10']);
  });

  it('cabeçalho de imagem vira parâmetro de mídia', () => {
    const defs: TemplateComponentDef[] = [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Oi {{1}}, olha essa novidade!' },
    ];
    expect(templateShape(defs)).toEqual({ headerVars: 0, bodyVars: 1, headerMedia: 'IMAGE' });
    const msg = buildCampaignMessage(
      defs,
      { variables: { header: [], body: [{ source: 'firstName', fallback: 'cliente' }] }, headerMediaUrl: 'https://exemplo.com/foto.jpg' },
      { name: 'bia lima' },
      new Map(),
    );
    expect(msg.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://exemplo.com/foto.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Bia' }] },
    ]);
    expect(msg.renderedBody).toBe('[imagem]\nOi Bia, olha essa novidade!');
  });
});

describe('erros da Meta', () => {
  it('separa desacelerar, pausar número, pausar campanha e falha do contato', () => {
    expect(classifyMetaCode(130429).kind).toBe('throttle');
    expect(classifyMetaCode(undefined, 429).kind).toBe('throttle');
    expect(classifyMetaCode(131048).kind).toBe('number'); // spam
    expect(classifyMetaCode(368).kind).toBe('number');
    expect(classifyMetaCode(190, 401).kind).toBe('number');
    expect(classifyMetaCode(132015).kind).toBe('template');
    expect(classifyMetaCode(131026).kind).toBe('recipient');
    expect(classifyMetaCode(131050)).toMatchObject({ kind: 'recipient', optOut: true });
    expect(classifyMetaCode(131000, 500).kind).toBe('transient');
    expect(classifyMetaCode(999, 400, 'Algo estranho')).toMatchObject({ kind: 'recipient', message: 'Algo estranho' });
  });
});
