import type { OrderNoticeKind, PrismaClient } from '@prisma/client';
import { getSetting, setSetting } from '../settings.js';

/**
 * Avisos de pedido: o que cada aviso é, quais situações do Bling o disparam e a configuração salva.
 * As situações personalizadas (Separando, Emitir Etiqueta, Enviado) têm id próprio em cada conta do
 * Bling, então o padrão é achado pelo NOME na primeira vez que a tela abre.
 */

export const ORDER_KINDS = ['RECEBIDO', 'SEPARANDO', 'PRONTO_RETIRAR', 'ENVIADO', 'ENTREGUE', 'CANCELADO'] as const satisfies readonly OrderNoticeKind[];
export type OrderKind = (typeof ORDER_KINDS)[number];

/** Grupos de situação do Bling que o hub entende. */
export const SITUATION_GROUPS = ['ABERTO', 'SEPARANDO', 'ETIQUETA', 'ENVIADO', 'ATENDIDO', 'CANCELADO'] as const;
export type SituationGroup = (typeof SITUATION_GROUPS)[number];

export const GROUP_LABEL: Record<SituationGroup, string> = {
  ABERTO: 'Pedido criado (Em aberto)',
  SEPARANDO: 'Separando',
  ETIQUETA: 'Emitir etiqueta',
  ENVIADO: 'Enviado',
  ATENDIDO: 'Atendido / cliente retirou',
  CANCELADO: 'Cancelado',
};

/** Nomes (sem acento, minúsculos) usados para achar o id de cada situação na conta. */
const GROUP_NAMES: Record<SituationGroup, string[]> = {
  ABERTO: ['em aberto'],
  SEPARANDO: ['separando'],
  ETIQUETA: ['emitir etiqueta'],
  ENVIADO: ['enviado'],
  ATENDIDO: ['atendido'],
  CANCELADO: ['cancelado'],
};
/** Ids fixos do Bling (iguais em toda conta). */
const STANDARD_IDS: Partial<Record<SituationGroup, number[]>> = { ABERTO: [6], ATENDIDO: [9], CANCELADO: [12] };

export interface KindInfo {
  label: string;
  when: string;
  /** Ordem das variáveis do corpo do template ({{1}}, {{2}}, ...). */
  vars: string[];
  suggested: { name: string; body: string; examples: string[] };
}

export const KIND_INFO: Record<OrderKind, KindInfo> = {
  RECEBIDO: {
    label: 'Recebemos seu pedido',
    when: 'Pedido criado (situação Em aberto)',
    vars: ['primeiro nome', 'nº do pedido', 'total', 'forma de pagamento'],
    suggested: {
      name: 'pedido_recebido',
      body: 'Olá, {{1}}! Recebemos seu pedido nº {{2}} na Oliver Cosméticos. Total: {{3}}. Pagamento: {{4}}. Vamos te avisando por aqui a cada etapa.',
      examples: ['Maria', '8825', 'R$ 474,00', 'Pix'],
    },
  },
  SEPARANDO: {
    label: 'Seu pedido está sendo separado',
    when: 'Pedido entrou em Separando',
    vars: ['primeiro nome', 'nº do pedido'],
    suggested: {
      name: 'pedido_separando',
      body: 'Oi, {{1}}! Seu pedido nº {{2}} está sendo separado pela nossa equipe. Avisamos assim que ele estiver pronto.',
      examples: ['Maria', '8825'],
    },
  },
  PRONTO_RETIRAR: {
    label: 'Pronto para retirar',
    when: 'Emitir etiqueta (ou Enviado) num pedido com "Retirar na loja"',
    vars: ['primeiro nome', 'nº do pedido', 'endereço e horário da loja'],
    suggested: {
      name: 'pedido_pronto_retirada',
      body: 'Oi, {{1}}! Seu pedido nº {{2}} está pronto para retirar. Endereço e horário: {{3}}. Te esperamos!',
      examples: ['Maria', '8825', 'Rua Exemplo, 123, Centro, de segunda a sábado, das 9h às 18h'],
    },
  },
  ENVIADO: {
    label: 'Seu pedido saiu',
    when: 'Enviado, com código de rastreio no pedido',
    vars: ['primeiro nome', 'nº do pedido', 'serviço (PAC, SEDEX...)', 'código de rastreio', 'link de rastreio'],
    suggested: {
      name: 'pedido_enviado',
      body: 'Oi, {{1}}! Seu pedido nº {{2}} saiu para entrega via {{3}}. Código de rastreio: {{4}}. Acompanhe pelo link {{5}} e qualquer dúvida é só responder aqui.',
      examples: ['Maria', '8814', 'PAC', 'AP761097925BR', 'https://rastreamento.correios.com.br/app/index.php?objetos=AP761097925BR'],
    },
  },
  ENTREGUE: {
    label: 'Pedido entregue, obrigado',
    when: 'Atendido (ou cliente retirou)',
    vars: ['primeiro nome', 'nº do pedido'],
    suggested: {
      name: 'pedido_entregue',
      body: 'Oi, {{1}}! Seu pedido nº {{2}} foi entregue. Obrigada por comprar na Oliver Cosméticos! Qualquer dúvida, é só responder esta mensagem.',
      examples: ['Maria', '8825'],
    },
  },
  CANCELADO: {
    label: 'Pedido cancelado',
    when: 'Cancelado',
    vars: ['primeiro nome', 'nº do pedido'],
    suggested: {
      name: 'pedido_cancelado',
      body: 'Oi, {{1}}. Seu pedido nº {{2}} foi cancelado. Se tiver alguma dúvida, é só responder esta mensagem que a nossa equipe te ajuda.',
      examples: ['Maria', '8825'],
    },
  },
};

export interface OrderNoticeConfig {
  /** Desligado por padrão: só liga depois dos templates aprovados. */
  enabled: boolean;
  /** Modo de teste: todo aviso vai para este número em vez da cliente. */
  testPhone: string | null;
  /** Lojas do Bling sem aviso (TikTok fica de fora por regra). */
  excludedStores: string[];
  /** "Entregue" e "Cancelado" só para pedidos que já receberam algum aviso (evita mensagem em venda de balcão). */
  onlyAfterFlow: boolean;
  /** Texto do {{3}} de "pronto para retirar". */
  storeInfo: string;
  /** Link de rastreio; {codigo} vira o código do pedido. */
  trackingUrl: string;
  /** Número que envia os avisos (vazio = primeiro número de atendimento ativo). */
  phoneNumberId: string | null;
  situations: Record<SituationGroup, number[]>;
  kinds: Record<OrderKind, { enabled: boolean; template: string }>;
  /** false até a primeira gravação (os ids das situações ainda vêm do padrão). */
  saved: boolean;
}

export const TIKTOK_STORE_ID = '206093178';
const KEY = 'orders.notices';
const STATE_KEY = 'orders.poll';

export function defaultConfig(): OrderNoticeConfig {
  return {
    enabled: false,
    testPhone: null,
    excludedStores: [TIKTOK_STORE_ID],
    onlyAfterFlow: true,
    storeInfo: '',
    trackingUrl: 'https://rastreamento.correios.com.br/app/index.php?objetos={codigo}',
    phoneNumberId: null,
    situations: { ABERTO: [6], SEPARANDO: [], ETIQUETA: [], ENVIADO: [], ATENDIDO: [9], CANCELADO: [12] },
    kinds: Object.fromEntries(ORDER_KINDS.map((k) => [k, { enabled: true, template: KIND_INFO[k].suggested.name }])) as OrderNoticeConfig['kinds'],
    saved: false,
  };
}

export async function getOrderConfig(db: PrismaClient): Promise<OrderNoticeConfig> {
  const saved = await getSetting<Partial<OrderNoticeConfig> | null>(db, KEY, null);
  const base = defaultConfig();
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    situations: { ...base.situations, ...saved.situations },
    kinds: Object.fromEntries(ORDER_KINDS.map((k) => [k, { ...base.kinds[k], ...saved.kinds?.[k] }])) as OrderNoticeConfig['kinds'],
    // a regra do TikTok não sai pela tela
    excludedStores: [...new Set([TIKTOK_STORE_ID, ...(saved.excludedStores ?? [])])],
  };
}

export async function saveOrderConfig(db: PrismaClient, cfg: OrderNoticeConfig): Promise<void> {
  await setSetting(db, KEY, { ...cfg, saved: true });
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Preenche os ids pelo nome das situações da conta (só antes da primeira gravação). */
export function situationsByName(list: { id: number; nome: string }[]): Record<SituationGroup, number[]> {
  const out = {} as Record<SituationGroup, number[]>;
  for (const g of SITUATION_GROUPS) {
    const ids = list.filter((s) => GROUP_NAMES[g].includes(fold(s.nome))).map((s) => s.id);
    out[g] = ids.length ? ids : (STANDARD_IDS[g] ?? []);
  }
  return out;
}

export function groupOf(cfg: OrderNoticeConfig, situacaoId: number): SituationGroup | null {
  return SITUATION_GROUPS.find((g) => cfg.situations[g].includes(situacaoId)) ?? null;
}

export interface PollState {
  /** Até quando os pedidos já foram vistos (a próxima rodada pede os alterados desde aqui). */
  cursor: string | null;
  /** Quando a foto inicial foi tirada (pedidos antigos não recebem aviso). */
  baselineAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastSummary: { seen: number; sent: number; skipped: number; failed: number } | null;
}

export async function getPollState(db: PrismaClient): Promise<PollState> {
  return getSetting<PollState>(db, STATE_KEY, { cursor: null, baselineAt: null, lastRunAt: null, lastError: null, lastSummary: null });
}

export async function savePollState(db: PrismaClient, st: PollState): Promise<void> {
  await setSetting(db, STATE_KEY, st);
}
