/** Cliente do painel para a API (mesma origem, via rewrite /api/*). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const isWrite = method !== 'GET';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: isWrite
        ? // JSON sempre (mesmo sem corpo) + cabeçalho anti-CSRF exigido pela API
          { 'Content-Type': 'application/json', 'x-oliver-panel': '1' }
        : {},
      body: isWrite ? JSON.stringify(init.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique se a API está no ar.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      // Recarga completa de propósito: sessão expirada limpa todo o estado em memória do painel.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/login?voltar=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, data.error ?? `Erro ${res.status}`);
  }
  return data as T;
}

export const fetcher = <T>(path: string) => api<T>(path);
