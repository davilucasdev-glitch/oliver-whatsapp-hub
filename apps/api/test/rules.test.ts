import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { dedupePhones, normalizePhone } from '../src/lib/phone.js';
import { detectConsentIntent } from '../src/messaging/opt-out.js';
import { isServiceWindowOpen, SERVICE_WINDOW_MS } from '../src/messaging/window.js';
import { decideQualityPolicy, mapMetaQuality, tierToDailyLimit } from '../src/numbers/quality.js';
import { signMetaPayload, verifyMetaSignature } from '../src/whatsapp/signature.js';

describe('opt-out por palavra-chave', () => {
  it.each(['SAIR', 'sair', ' Parar ', 'CANCELAR', 'stop', 'Pare!', 'quero sair', 'sair da lista', 'me tira da lista',
    'parar de receber mensagens', 'não quero mais', 'Não quero receber', 'cancelar inscrição', 'Descadastrar 🙏',
    'Parar promoções'])(
    '"%s" é opt-out',
    (text) => expect(detectConsentIntent(text)).toBe('OPT_OUT'),
  );

  it.each(['quero cancelar meu pedido', 'como faço pra sair um pedido?', 'oi, o perfume saiu de estoque?',
    'cancelar o pedido 1234', 'pode parar o envio do meu pedido', 'Olá', '', 'sairia caro?'])(
    '"%s" NÃO é opt-out',
    (text) => expect(detectConsentIntent(text)).not.toBe('OPT_OUT'),
  );

  it('VOLTAR é opt-in', () => {
    expect(detectConsentIntent('voltar')).toBe('OPT_IN');
    expect(detectConsentIntent('Quero receber!')).toBe('OPT_IN');
  });
});

describe('janela de 24h', () => {
  const now = new Date('2026-11-14T15:00:00Z');
  it('aberta logo após mensagem do cliente', () => {
    expect(isServiceWindowOpen(new Date(now.getTime() - 60_000), now)).toBe(true);
  });
  it('aberta até 23h59', () => {
    expect(isServiceWindowOpen(new Date(now.getTime() - SERVICE_WINDOW_MS + 1000), now)).toBe(true);
  });
  it('fechada com exatamente 24h ou mais', () => {
    expect(isServiceWindowOpen(new Date(now.getTime() - SERVICE_WINDOW_MS), now)).toBe(false);
    expect(isServiceWindowOpen(new Date(now.getTime() - 3 * SERVICE_WINDOW_MS), now)).toBe(false);
  });
  it('fechada quando o cliente nunca escreveu', () => {
    expect(isServiceWindowOpen(null, now)).toBe(false);
  });
});

describe('telefone E.164', () => {
  it.each([
    ['(11) 98888-7777', '+5511988887777'],
    ['11988887777', '+5511988887777'],
    ['5511988887777', '+5511988887777'],
    ['+55 11 9 8888-7777', '+5511988887777'],
    ['011 98888-7777', '+5511988887777'],
    ['(21) 3333-4444', '+552133334444'],
    ['+1 415 555 2671', '+14155552671'],
  ])('%s → %s', (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it.each(['123', 'abc', '(11) 8888-77', '5511888887777', '+55 00 98888-7777'])('%s é inválido', (raw) =>
    expect(normalizePhone(raw)).toBeNull(),
  );

  it('deduplica números iguais escritos de formas diferentes', () => {
    const r = dedupePhones(['11988887777', '+55 (11) 98888-7777', '5511988887777', 'lixo', '21999990000']);
    expect(r.valid).toEqual(['+5511988887777', '+5521999990000']);
    expect(r.invalid).toEqual(['lixo']);
  });
});

describe('assinatura X-Hub-Signature-256', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  it('aceita assinatura correta', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, 's3cr3t'), 's3cr3t')).toBe(true);
  });
  it('recusa segredo errado, corpo alterado ou cabeçalho ausente/malformado', () => {
    const sig = signMetaPayload(body, 's3cr3t');
    expect(verifyMetaSignature(body, sig, 'outro')).toBe(false);
    expect(verifyMetaSignature(body + ' ', sig, 's3cr3t')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cr3t')).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', 's3cr3t')).toBe(false);
  });
});

describe('qualidade do número', () => {
  it('mapeia as cores da Meta', () => {
    expect(mapMetaQuality('GREEN')).toBe('HIGH');
    expect(mapMetaQuality('YELLOW')).toBe('MEDIUM');
    expect(mapMetaQuality('RED')).toBe('LOW');
    expect(mapMetaQuality(undefined)).toBe('UNKNOWN');
  });
  it('MÉDIA reduz o ritmo pela metade e alerta; BAIXA pausa e alerta crítico', () => {
    const medium = decideQualityPolicy('MEDIUM', 20, 'Loja', 'HIGH');
    expect(medium.sendRatePerMinute).toBe(10);
    expect(medium.campaignsPaused).toBe(false);
    expect(medium.alert?.level).toBe('WARNING');
    const low = decideQualityPolicy('LOW', 20, 'Loja', 'MEDIUM');
    expect(low.campaignsPaused).toBe(true);
    expect(low.alert?.level).toBe('CRITICAL');
  });
  it('ALTA mantém o ritmo configurado', () => {
    expect(decideQualityPolicy('HIGH', 20, 'Loja', 'HIGH')).toEqual({ sendRatePerMinute: 20, campaignsPaused: false });
  });
  it('converte tier em limite diário', () => {
    expect(tierToDailyLimit('TIER_1K')).toBe(1000);
    expect(tierToDailyLimit('TIER_250')).toBe(250);
    expect(tierToDailyLimit('TIER_100K')).toBe(100_000);
    expect(tierToDailyLimit(undefined)).toBeNull();
  });
});

describe('criptografia AES-GCM', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  it('ida e volta', () => {
    const enc = encrypt('EAAG-token-secreto', key);
    expect(enc).not.toContain('EAAG');
    expect(decrypt(enc, key)).toBe('EAAG-token-secreto');
  });
  it('falha com chave errada ou dado adulterado', () => {
    const enc = encrypt('abc', key);
    expect(() => decrypt(enc, Buffer.alloc(32, 2).toString('base64'))).toThrow();
    const parts = enc.split(':');
    parts[3] = Buffer.from('xyz').toString('base64');
    expect(() => decrypt(parts.join(':'), key)).toThrow();
  });
});
