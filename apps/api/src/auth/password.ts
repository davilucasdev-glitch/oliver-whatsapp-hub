import bcrypt from 'bcryptjs';

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummy: Promise<string> | undefined;
/** Hash real de uma senha aleatória: usado quando o e-mail não existe, para o tempo de resposta ser igual. */
export function dummyHash(): Promise<string> {
  dummy ??= bcrypt.hash(`dummy-${Math.random()}`, COST);
  return dummy;
}

/** Senha forte: mín. 10 caracteres e 3 de 4 tipos (minúscula, maiúscula, número, símbolo). */
export function passwordProblems(plain: string): string | null {
  if (plain.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (plain.length > 128) return 'A senha pode ter no máximo 128 caracteres.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(plain)).length;
  if (classes < 3) return 'Use pelo menos 3 destes: letra minúscula, maiúscula, número e símbolo.';
  return null;
}
