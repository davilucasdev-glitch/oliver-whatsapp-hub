import { describe, expect, it } from 'vitest';
import { cleanReply } from '../src/bot/engine.js';
import { describeHours, isOpenAt, nextOpening, parseBusinessHours, type BusinessHours } from '../src/bot/hours.js';
import { messageToHistory } from '../src/bot/io.js';
import { pendingPlaceholders } from '../src/bot/knowledge.js';
import { buildDynamicContext, buildHistoryMessages, buildStaticSystemPrompt } from '../src/bot/prompt.js';
import { zonedToUtc } from '../src/lib/time.js';

const TZ = 'America/Sao_Paulo';
const H: BusinessHours = {
  timezone: TZ,
  days: { 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: ['09:00', '13:00'] },
  closedDates: ['2026-11-20'],
};
// 2026-11-16 é segunda-feira
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, TZ);

describe('horário de atendimento', () => {
  it('abre e fecha no horário de Brasília', () => {
    expect(isOpenAt(at(16, 8, 59), H)).toBe(false);
    expect(isOpenAt(at(16, 9, 0), H)).toBe(true);
    expect(isOpenAt(at(16, 17, 59), H)).toBe(true);
    expect(isOpenAt(at(16, 18, 0), H)).toBe(false);
    expect(isOpenAt(at(21, 12, 0), H)).toBe(true); // sábado
    expect(isOpenAt(at(21, 13, 30), H)).toBe(false);
    expect(isOpenAt(at(22, 10, 0), H)).toBe(false); // domingo
    expect(isOpenAt(at(20, 10, 0), H)).toBe(false); // feriado
  });

  it('diz quando volta', () => {
    expect(nextOpening(at(16, 7, 0), H)).toBe('hoje às 09:00');
    expect(nextOpening(at(16, 19, 0), H)).toBe('amanhã às 09:00');
    expect(nextOpening(at(21, 14, 0), H)).toBe('segunda (23/11) às 09:00'); // sáb à tarde → pula domingo
    expect(nextOpening(at(19, 19, 0), H)).toBe('sábado (21/11) às 09:00'); // quinta à noite → sexta é feriado
    expect(nextOpening(at(16, 7, 0), { ...H, days: {} })).toBeNull();
  });

  it('descreve agrupando dias iguais e aceita configuração inválida com padrão', () => {
    expect(describeHours(H)).toBe('seg a sex 09:00–18:00; sáb 09:00–13:00');
    expect(parseBusinessHours({ days: 'x' }).days[1]).toEqual(['09:00', '18:00']);
  });
});

describe('montagem do contexto do bot', () => {
  it('histórico: junta mensagens seguidas, começa e termina no cliente', () => {
    const msgs = buildHistoryMessages([
      { role: 'assistant', text: '(mensagem de campanha) Chegaram novidades!' },
      { role: 'user', text: 'oi' },
      { role: 'user', text: 'tem lattafa?' },
      { role: 'assistant', text: 'Tenho sim!' },
      { role: 'user', text: 'quanto custa?' },
      { role: 'assistant', text: 'resposta que ficou sem pergunta depois' },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[0]!.content).toBe('(início da conversa)');
    expect(msgs[2]!.content).toBe('oi\ntem lattafa?');
    expect(msgs.at(-1)!.content).toBe('quanto custa?');
  });

  it('mensagens do banco viram texto com quem falou', () => {
    const base = { templateName: null };
    expect(messageToHistory({ ...base, direction: 'INBOUND', type: 'text', body: 'oi', sentBy: 'CONTACT' })).toEqual({ role: 'user', text: 'oi' });
    expect(messageToHistory({ ...base, direction: 'INBOUND', type: 'image', body: 'esse aqui', sentBy: 'CONTACT' })?.text).toBe('[o cliente enviou uma foto com a legenda: esse aqui]');
    expect(messageToHistory({ ...base, direction: 'INBOUND', type: 'audio', body: null, sentBy: 'CONTACT' })?.text).toBe('[o cliente enviou um áudio]');
    expect(messageToHistory({ ...base, direction: 'INBOUND', type: 'reaction', body: null, sentBy: 'CONTACT' })).toBeNull();
    expect(messageToHistory({ ...base, direction: 'OUTBOUND', type: 'text', body: 'já vejo', sentBy: 'HUMAN' })?.text).toBe('(mensagem do atendente humano) já vejo');
    expect(messageToHistory({ direction: 'OUTBOUND', type: 'template', body: 'Oi Maria', sentBy: 'CAMPAIGN', templateName: 'promo' })?.text).toBe('(mensagem de campanha promo) Oi Maria');
    expect(messageToHistory({ ...base, direction: 'OUTBOUND', type: 'image', body: 'Asad — R$ 189,90', sentBy: 'BOT' })?.text).toBe('[foto/arquivo enviado: Asad — R$ 189,90]');
  });

  it('parte fixa traz as regras e a base de conhecimento', () => {
    const s = buildStaticSystemPrompt('# Oliver\nNome do assistente: Oli');
    expect(s).toContain('Nunca invente');
    expect(s).toContain('inspirado em X');
    expect(s).toContain('transferir_para_humano');
    expect(s).toContain('Nome do assistente: Oli');
    // nada que muda a cada chamada (quebraria o cache)
    expect(s).not.toMatch(/\d{2}:\d{2}/);
  });

  it('parte do momento: horário, cliente, tentativas e resumo', () => {
    const ctx = buildDynamicContext({
      now: at(21, 14, 30),
      timeZone: TZ,
      humanOpen: false,
      nextOpening: 'segunda (23/11) às 09:00',
      hoursDescription: describeHours(H),
      customer: { name: 'Maria', phone: '+5511988887777', hasDocument: false },
      failedAttempts: 1,
      maxFailedAttempts: 2,
      summary: 'Cliente procura perfume doce para presente.',
    });
    expect(ctx).toContain('sábado, 21/11/2026');
    expect(ctx).toContain('14:30');
    expect(ctx).toContain('FECHADO agora');
    expect(ctx).toContain('Volta segunda (23/11) às 09:00');
    expect(ctx).toContain('Maria');
    expect(ctx).not.toContain('988887777'); // telefone não precisa ir para o modelo
    expect(ctx).toContain('1 de 2. Se não conseguir resolver agora, transfira');
    expect(ctx).toContain('Cliente procura perfume doce para presente.');
  });

  it('limpa a resposta antes de mandar no WhatsApp', () => {
    expect(cleanReply('## Opções\n**Asad** por R$ 189,90 [DEFINIR: frete]\n\n\n\nQuer?')).toBe('Opções\n*Asad* por R$ 189,90 \n\nQuer?');
  });

  it('lista os [DEFINIR] pendentes da base', () => {
    expect(pendingPlaceholders('- **Site:** [DEFINIR URL]\nok\n- Pix: [DEFINIR]')).toEqual(['Site: [DEFINIR URL]', 'Pix: [DEFINIR]']);
  });
});
