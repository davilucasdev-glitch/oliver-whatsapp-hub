/**
 * Abstração de filas. Produção: BullMQ + Redis. Dev sem Redis / testes: fila em memória
 * com a mesma semântica básica (jobId para deduplicar, tentativas com backoff, concorrência,
 * limitador de taxa).
 */

export const QUEUES = {
  inbound: 'inbound', // eventos do webhook (mensagens recebidas + status)
  outbound: 'outbound', // envios avulsos (bot, humano, sistema)
  campaign: 'campaign', // disparos de campanha (ritmo controlado)
  bling: 'bling', // sync de produtos / contatos
  bot: 'bot', // respostas do bot de IA (com espera para juntar mensagens seguidas)
  orders: 'orders', // avisos de pedido (lê as mudanças de situação no Bling)
  charges: 'charges', // cópia das contas a receber do Bling (cobrança)
  relation: 'relation', // aniversário e última compra (relacionamento)
  site: 'site', // avisos do hub para o site (mensagem recebida, status, opt-out)
  health: 'health', // saúde do sistema (rotinas paradas → alerta para os administradores)
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface AddJobOptions {
  /** Mesmo jobId = job ignorado se já existir (idempotência). */
  jobId?: string;
  delayMs?: number;
  attempts?: number;
  /** backoff exponencial base, em ms */
  backoffMs?: number;
  /** apaga o job ao terminar (o mesmo jobId pode voltar a ser usado; evita acumular jobs periódicos) */
  removeOnComplete?: boolean;
}

export interface JobContext {
  id: string;
  name: string;
  attempt: number; // começa em 1
}

export type JobHandler<T> = (data: T, ctx: JobContext) => Promise<void>;

export interface ProcessOptions {
  concurrency?: number;
  /** no máximo `max` jobs a cada `durationMs` */
  limiter?: { max: number; durationMs: number };
}

export interface QueueBus {
  readonly driver: 'bullmq' | 'memory';
  add<T>(queue: QueueName, name: string, data: T, opts?: AddJobOptions): Promise<void>;
  process<T>(queue: QueueName, handler: JobHandler<T>, opts?: ProcessOptions): void;
  /** Espera todas as filas esvaziarem (usado em testes / driver memory). */
  drain(timeoutMs?: number): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
