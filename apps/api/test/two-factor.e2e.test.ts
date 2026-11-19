import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, hashRecoveryCode, hotp, totpAt, verifyTotp } from '../src/auth/totp.js';
import { ADMIN, createTestContext, loginAsAdmin, resetDb, type TestContext } from './helpers.js';

describe('TOTP (RFC 6238)', () => {
  // segredo de teste da RFC: "12345678901234567890"
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('base32 ida e volta', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('bate com os vetores oficiais (6 últimos dígitos)', () => {
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 1_234_567_890_000)).toBe('005924');
    expect(totpAt(secret, 2_000_000_000_000)).toBe('279037');
    expect(hotp(secret, 0)).toBe('755224'); // RFC 4226
  });

  it('aceita 30 s de diferença no relógio, recusa mais que isso e código já usado', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, code, { now: now + 30_000 })).not.toBeNull();
    expect(verifyTotp(secret, code, { now: now + 90_000 })).toBeNull();
    const step = verifyTotp(secret, code, { now })!;
    expect(verifyTotp(secret, code, { now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now })).toBe(step); // aceita com espaço
  });

  it('códigos de recuperação: 10, únicos, comparados sem diferenciar maiúsculas/hífen', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashRecoveryCode(codes[0]!.toUpperCase().replace('-', ''))).toBe(hashes[0]);
  });
});

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAsAdmin>>;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDb(ctx.db);
  admin = await loginAsAdmin(ctx.app);
});

const login = () => ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
const login2fa = (challenge: string, code: string) => ctx.app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge, code } });

async function enable(): Promise<{ secret: string; recovery: string[] }> {
  const setup = await admin.call('POST', '/api/auth/2fa/setup', { password: ADMIN.password });
  expect(setup.statusCode, setup.body).toBe(200);
  const { secret, qrSvg, otpauthUrl } = setup.json();
  expect(qrSvg).toContain('<svg');
  expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Oliver%20Hub%3A/);
  const raw = secret.replace(/\s/g, '');
  const res = await admin.call('POST', '/api/auth/2fa/enable', { code: totpAt(raw) });
  expect(res.statusCode, res.body).toBe(200);
  return { secret: raw, recovery: res.json().recoveryCodes };
}

describe('verificação em duas etapas no painel', () => {
  it('ativar exige senha e o primeiro código; o segredo fica criptografado', async () => {
    expect((await admin.call('POST', '/api/auth/2fa/setup', { password: 'errada' })).statusCode).toBe(400);
    await admin.call('POST', '/api/auth/2fa/setup', { password: ADMIN.password });
    expect((await admin.call('POST', '/api/auth/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    const { secret, recovery } = await enable();
    expect(recovery).toHaveLength(10);
    const user = await ctx.db.user.findFirstOrThrow();
    expect(user.totpSecret).toMatch(/^v1:/);
    expect(user.totpSecret).not.toContain(secret);
    expect(JSON.stringify(user.recoveryCodes)).not.toContain(recovery[0]); // só hashes
    const sec = (await admin.call('GET', '/api/auth/security')).json();
    expect(sec).toMatchObject({ twoFactor: true, recoveryCodesLeft: 10 });
    expect((await admin.call('GET', '/api/auth/status')).json().user.twoFactor).toBe(true);
  });

  it('login pede o código: sem ele não há sessão; código certo entra; reuso do mesmo código é recusado', async () => {
    const { secret } = await enable();
    const first = await login();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ twoFactorRequired: true });
    expect(first.cookies.find((c) => c.name === 'oh_session')).toBeUndefined();

    // o código usado para ativar não vale de novo (proteção contra repetição)
    const reused = await login2fa(first.json().challenge, totpAt(secret));
    expect(reused.statusCode).toBe(401);

    const user = await ctx.db.user.findFirstOrThrow();
    await ctx.db.user.update({ where: { id: user.id }, data: { totpLastStep: user.totpLastStep! - 2 } }); // simula passar o tempo
    const ok = await login2fa(first.json().challenge, totpAt(secret));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.cookies.find((c) => c.name === 'oh_session')).toBeDefined();
    // desafio é de uso único
    expect((await login2fa(first.json().challenge, totpAt(secret))).statusCode).toBe(401);
  });

  it('5 códigos errados derrubam o desafio', async () => {
    await enable();
    const { challenge } = (await login()).json();
    for (let i = 0; i < 5; i++) expect((await login2fa(challenge, '111111')).statusCode).toBe(401);
    const res = await login2fa(challenge, '111111');
    expect(res.json().error).toMatch(/Entre com a senha de novo/);
  });

  it('código de recuperação entra uma vez só', async () => {
    const { recovery } = await enable();
    const a = await login2fa((await login()).json().challenge, recovery[0]!.toUpperCase());
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    const b = await login2fa((await login()).json().challenge, recovery[0]!);
    expect(b.statusCode).toBe(401);
  });

  it('ativar derruba as outras sessões; desativar exige senha + código', async () => {
    const other = await login(); // segunda sessão, antes do 2FA
    const otherCookie = other.cookies.find((c) => c.name === 'oh_session')!.value;
    const { recovery } = await enable();
    const st = await ctx.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: `oh_session=${otherCookie}` } });
    expect(st.json().user).toBeNull();

    expect((await admin.call('POST', '/api/auth/2fa/disable', { password: ADMIN.password, code: '123456' })).statusCode).toBe(400);
    const off = await admin.call('POST', '/api/auth/2fa/disable', { password: ADMIN.password, code: recovery[1] });
    expect(off.statusCode, off.body).toBe(200);
    expect((await login()).json().user.email).toBe(ADMIN.email); // volta a entrar só com a senha
  });

  it('gerar novos códigos de recuperação invalida os antigos', async () => {
    const { secret, recovery } = await enable();
    const user = await ctx.db.user.findFirstOrThrow();
    await ctx.db.user.update({ where: { id: user.id }, data: { totpLastStep: user.totpLastStep! - 2 } });
    const res = await admin.call('POST', '/api/auth/2fa/recovery-codes', { code: totpAt(secret) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().recoveryCodes[0]).not.toBe(recovery[0]);
    expect((await login2fa((await login()).json().challenge, recovery[0]!)).statusCode).toBe(401);
  });
});
