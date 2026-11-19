import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3001'),
  PANEL_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /** bullmq = Redis (produção). memory = fila em processo (dev sem Redis / testes). */
  QUEUE_DRIVER: z.enum(['bullmq', 'memory']).default('bullmq'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Roda os workers dentro do processo da API (útil com QUEUE_DRIVER=memory). */
  RUN_WORKERS_IN_API: bool,

  /** Chave de 32 bytes em base64 para AES-256-GCM (tokens no banco). */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'ENCRYPTION_KEY deve ter 32 bytes em base64 (gere com: openssl rand -base64 32)',
  }),

  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_APP_SECRET: z.string().min(1),
  /** ID do app da Meta: só para criar template com PDF/imagem no cabeçalho (upload do exemplo). */
  META_APP_ID: z.string().default(''),
  META_VERIFY_TOKEN: z.string().min(8),
  /** Token padrão (System User permanente); cada número pode ter o seu no banco. */
  META_ACCESS_TOKEN: z.string().default(''),
  META_WABA_ID: z.string().default(''),
  META_DEFAULT_PHONE_NUMBER_ID: z.string().default(''),

  /** echo = resposta de teste fixa (etapa 1). ai = bot Claude. off = só registra. */
  BOT_MODE: z.enum(['echo', 'ai', 'off']).default('echo'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  /** Esforço de raciocínio. "low" é o indicado para conversa (responde rápido). */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /** Só para testes/dev com o Claude simulado (npm run mock:claude). Vazio = API oficial. */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().min(512).max(64000).default(8000),
  /** Intervalo da rodada do motor de campanhas (ms). O ritmo de cada número vem de Números. */
  CAMPAIGN_TICK_MS: z.coerce.number().int().min(500).max(60000).default(2000),
  /** Espera antes de responder, para juntar mensagens que o cliente manda em sequência. */
  BOT_DEBOUNCE_MS: z.coerce.number().int().min(0).max(30000).default(2500),
  /** Caminho do knowledge/oliver.md (padrão: procura na raiz do projeto). */
  KNOWLEDGE_FILE: z.string().optional(),

  /** Bling API v3 (app criado em Bling > Central de Extensões > Área do Integrador). */
  BLING_CLIENT_ID: z.string().default(''),
  BLING_CLIENT_SECRET: z.string().default(''),
  /** Precisa ser IGUAL ao "Link de redirecionamento" cadastrado no app do Bling. Padrão: PANEL_URL/api/bling/callback */
  BLING_REDIRECT_URI: z.string().url().optional(),
  BLING_API_BASE_URL: z.string().url().default('https://api.bling.com.br/Api/v3'),
  BLING_OAUTH_BASE_URL: z.string().url().default('https://www.bling.com.br/Api/v3/oauth'),
  BLING_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** De quanto em quanto tempo olhar os pedidos alterados no Bling (avisos de pedido). */
  ORDERS_POLL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  /** Intervalo mínimo entre chamadas (o Bling aceita 3 por segundo). */
  BLING_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(350),

  /** Exigido para criar o primeiro acesso ao painel (tela "Primeiro acesso"). */
  SETUP_TOKEN: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /** Tentativas de login por IP a cada 15 minutos. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** true em produção com HTTPS; false para http://localhost */
  COOKIE_SECURE: bool,
  /** Template usado no "testar envio" quando a janela de 24h está fechada. */
  TEST_TEMPLATE_NAME: z.string().default('hello_world'),
  TEST_TEMPLATE_LANGUAGE: z.string().default('en_US'),

  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1200),
  TZ_BUSINESS: z.string().default('America/Sao_Paulo'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida no .env:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Só para testes: força recarregar o .env. */
export function resetEnvCache(): void {
  cached = undefined;
}
