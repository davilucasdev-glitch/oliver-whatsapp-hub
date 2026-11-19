import { blingClient } from '../bling/client.js';
import type { BlingPage } from '../bling/types.js';
import type { Deps } from '../deps.js';
import { childLogger } from '../lib/logger.js';
import { getOrderConfig, situationsByName, type OrderNoticeConfig } from './config.js';

const log = childLogger('pedidos:situacoes');

/** Situações do módulo de vendas da conta (para a tela de configuração). */
export async function listSaleSituations(deps: Deps): Promise<{ id: number; nome: string }[]> {
  const client = blingClient(deps);
  const mods = await client.get<BlingPage<{ id: number; nome: string; descricao?: string }>>('/situacoes/modulos');
  const vendas = mods.data.find((m) => /vendas/i.test(m.nome) || /pedidos de venda/i.test(m.descricao ?? ''));
  if (!vendas) return [];
  const res = await client.get<BlingPage<{ id: number; nome: string }>>(`/situacoes/modulos/${vendas.id}`);
  return res.data.map((s) => ({ id: s.id, nome: s.nome }));
}

let cache: { at: number; byName: OrderNoticeConfig['situations'] } | null = null;
const TTL = 30 * 60_000;

/**
 * Configuração dos avisos de pedido com as situações preenchidas: se ninguém salvou a tela
 * ainda, os ids de Separando / Emitir Etiqueta / Enviado são achados pelo nome no Bling
 * (guardado 30 min). Assim os avisos da equipe funcionam sem precisar abrir a tela antes.
 */
export async function effectiveOrderConfig(deps: Deps): Promise<OrderNoticeConfig> {
  const cfg = await getOrderConfig(deps.db);
  if (cfg.saved) return cfg;
  if (!cache || Date.now() - cache.at > TTL) {
    try {
      cache = { at: Date.now(), byName: situationsByName(await listSaleSituations(deps)) };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Não foi possível ler as situações do Bling');
      return cfg;
    }
  }
  return { ...cfg, situations: cache.byName };
}

/** Para os testes (cada teste tem um Bling simulado novo). */
export function clearSituationCache() {
  cache = null;
}
