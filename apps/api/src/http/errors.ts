import { z, type ZodType } from 'zod';

// Mensagens de validação em português no painel.
z.config(z.locales.pt());

/** Erro com status HTTP e mensagem amigável (em português) para o painel. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg = 'Não encontrado') => new HttpError(404, msg);

/** Valida corpo/query com zod e devolve 400 com a primeira mensagem legível. */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join('.');
    throw badRequest(field ? `${field}: ${first?.message}` : (first?.message ?? 'Dados inválidos'), r.error.issues);
  }
  return r.data;
}
