/**
 * Janela de atendimento de 24h da Meta: texto livre só pode ser enviado até 24h
 * depois da última mensagem RECEBIDA do cliente. Fora dela, só template aprovado.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isServiceWindowOpen(lastInboundAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  return elapsed >= 0 && elapsed < SERVICE_WINDOW_MS;
}

export function serviceWindowClosesAt(lastInboundAt: Date | null | undefined): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS) : null;
}

export class ServiceWindowClosedError extends Error {
  constructor(readonly lastInboundAt: Date | null) {
    super(
      'A janela de 24h está fechada para este contato: só é possível enviar um template aprovado pela Meta.',
    );
    this.name = 'ServiceWindowClosedError';
  }
}
