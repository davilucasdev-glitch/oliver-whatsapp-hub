/**
 * Checklist de produção: confere o .env e o banco e lista o que falta, em português.
 *   npm run checklist                    (local, lê o .env da raiz)
 *   docker compose run --rm api node dist/scripts/checklist.js   (servidor)
 * Só lê; não altera nada. Sai com código 1 se houver item obrigatório pendente.
 */
import { PrismaClient } from '@prisma/client';
import { getKnowledge, pendingPlaceholders } from '../src/bot/knowledge.js';
import { loadEnv, type Env } from '../src/config/env.js';

type Level = 'ok' | 'falta' | 'atenção';
const rows: { level: Level; area: string; text: string }[] = [];
const add = (level: Level, area: string, text: string) => rows.push({ level, area, text });
const check = (cond: boolean, area: string, ok: string, missing: string, level: Level = 'falta') => add(cond ? 'ok' : level, area, cond ? ok : missing);

const isLocal = (url: string) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);

function envChecks(env: Env) {
  const prod = env.NODE_ENV === 'production';
  check(prod, 'Servidor', 'NODE_ENV=production', 'NODE_ENV não é production (ok em desenvolvimento)', 'atenção');
  check(env.PUBLIC_BASE_URL.startsWith('https://') && !isLocal(env.PUBLIC_BASE_URL), 'Servidor', `PUBLIC_BASE_URL = ${env.PUBLIC_BASE_URL}`, 'PUBLIC_BASE_URL precisa ser o endereço público com https (a Meta só chama webhook https)');
  check(env.PANEL_URL.startsWith('https://') && !isLocal(env.PANEL_URL), 'Servidor', `PANEL_URL = ${env.PANEL_URL}`, 'PANEL_URL precisa ser o endereço https do painel', 'atenção');
  check(env.COOKIE_SECURE, 'Segurança', 'COOKIE_SECURE=true', 'COOKIE_SECURE=true é obrigatório em produção com https');
  check(env.SETUP_TOKEN.length >= 12, 'Segurança', 'SETUP_TOKEN definido', 'SETUP_TOKEN (código do primeiro acesso) vazio ou curto: use 12+ caracteres aleatórios', 'atenção');
  check(env.QUEUE_DRIVER === 'bullmq', 'Servidor', 'Filas no Redis (QUEUE_DRIVER=bullmq)', 'QUEUE_DRIVER=memory perde a fila se o processo reiniciar: use bullmq + Redis em produção');
  check(!/troque|changeme|postgres:postgres@/i.test(env.DATABASE_URL), 'Servidor', 'Senha do banco definida', 'DATABASE_URL com senha padrão/de exemplo');

  check(Boolean(env.META_ACCESS_TOKEN), 'Meta', 'META_ACCESS_TOKEN definido', 'META_ACCESS_TOKEN (token permanente do usuário do sistema) vazio');
  check(Boolean(env.META_WABA_ID) && env.META_WABA_ID !== 'WABA_DEV', 'Meta', `META_WABA_ID = ${env.META_WABA_ID}`, 'META_WABA_ID vazio ou de desenvolvimento');
  check(Boolean(env.META_DEFAULT_PHONE_NUMBER_ID) && env.META_DEFAULT_PHONE_NUMBER_ID !== 'PNID_DEV', 'Meta', 'META_DEFAULT_PHONE_NUMBER_ID definido', 'META_DEFAULT_PHONE_NUMBER_ID vazio ou de desenvolvimento');
  check(env.META_GRAPH_BASE_URL === 'https://graph.facebook.com', 'Meta', 'Usando a Graph API oficial', `META_GRAPH_BASE_URL aponta para ${env.META_GRAPH_BASE_URL} (Meta simulada?)`);
  check(env.META_APP_SECRET.length >= 16, 'Meta', 'META_APP_SECRET definido', 'META_APP_SECRET parece inválido');

  check(Boolean(env.BLING_CLIENT_ID && env.BLING_CLIENT_SECRET), 'Bling', 'App do Bling configurado', 'BLING_CLIENT_ID / BLING_CLIENT_SECRET vazios', 'atenção');
  check(!isLocal(env.BLING_API_BASE_URL), 'Bling', 'Usando a API oficial do Bling', `BLING_API_BASE_URL aponta para ${env.BLING_API_BASE_URL} (Bling simulado?)`);

  check(env.BOT_MODE === 'ai', 'Bot', 'BOT_MODE=ai', `BOT_MODE=${env.BOT_MODE}: o bot de IA não responde no WhatsApp`, 'atenção');
  check(!env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL.startsWith('https://api.anthropic.com'), 'Bot', 'Usando a API oficial da Anthropic', `ANTHROPIC_BASE_URL aponta para ${env.ANTHROPIC_BASE_URL} (Claude simulado?)`);
}

async function dbChecks(env: Env, db: PrismaClient) {
  const [users, numbers, templates, optIn, hours, auth, products, apiKey] = await Promise.all([
    db.user.findMany({ select: { email: true, totpSecret: true } }),
    db.phoneNumber.findMany({ where: { isActive: true } }),
    db.template.count({ where: { status: 'APPROVED', category: 'MARKETING' } }),
    db.contact.count({ where: { optIn: true, optOut: false } }),
    db.setting.findUnique({ where: { key: 'business.hours' } }),
    db.blingAuth.findUnique({ where: { id: 'default' } }),
    db.product.count({ where: { active: true } }),
    db.setting.findUnique({ where: { key: 'anthropic.apiKeyEnc' } }),
  ]);
  check(users.length > 0, 'Painel', `Acesso criado (${users.map((u) => u.email).join(', ')})`, 'Nenhum acesso criado: abra o painel e faça o Primeiro acesso');
  if (users.length) check(users.every((u) => u.totpSecret), 'Segurança', 'Verificação em duas etapas ativa', 'Ative a verificação em duas etapas em Segurança (recomendado)', 'atenção');
  check(numbers.length > 0, 'Meta', `${numbers.length} número(s) cadastrado(s)`, 'Nenhum número cadastrado em Números');
  for (const n of numbers) {
    if (n.qualityRating === 'LOW') add('atenção', 'Meta', `Número ${n.displayName} com qualidade BAIXA`);
    if (n.status !== 'CONNECTED') add('atenção', 'Meta', `Número ${n.displayName}: status ${n.status} (clique em Atualizar em Números)`);
  }
  check(templates > 0, 'Campanhas', `${templates} template(s) de marketing aprovado(s)`, 'Nenhum template de marketing aprovado (crie em Templates e aguarde a Meta)', 'atenção');
  check(optIn > 0, 'Campanhas', `${optIn} contato(s) com opt-in`, 'Nenhum contato com opt-in: importe a lista com a origem do consentimento', 'atenção');
  check(Boolean(hours), 'Bot', 'Horário de atendimento humano definido', 'Horário de atendimento humano não definido (Bot de IA → Configurações)', 'atenção');
  check(Boolean(auth), 'Bling', `Bling conectado (${products} produtos ativos)`, 'Bling não conectado: Produtos → Conectar ao Bling', 'atenção');
  check(Boolean(env.ANTHROPIC_API_KEY || apiKey), 'Bot', 'Chave da Anthropic configurada', 'Sem chave da Anthropic (ANTHROPIC_API_KEY ou Bot de IA → Configurações): o bot só transfere para a equipe');
  // ── Partes novas: avisos de pedido, cobrança, equipe, site, templates ──
  const approved = new Set((await db.template.findMany({ where: { status: 'APPROVED' }, select: { name: true } })).map((t) => t.name));
  const setting = async <T,>(key: string) => ((await db.setting.findUnique({ where: { key } }))?.value ?? null) as T | null;
  const orders = await setting<{ enabled?: boolean; testPhone?: string | null; kinds?: Record<string, { enabled: boolean; template: string }> }>('orders.notices');
  check(Boolean(orders?.enabled), 'Avisos de pedido', 'Ligados', 'Desligados (Avisos de pedido → Mandar avisos)', 'atenção');
  if (orders?.enabled && orders.testPhone) add('atenção', 'Avisos de pedido', `MODO DE TESTE ligado: todo aviso vai para ${orders.testPhone} e não para as clientes`);
  const orderTpls = Object.values(orders?.kinds ?? {}).filter((k) => k.enabled).map((k) => k.template);
  const missingOrders = orderTpls.filter((t) => !approved.has(t));
  if (orders?.enabled) check(missingOrders.length === 0, 'Avisos de pedido', 'Templates aprovados', `Templates sem aprovação: ${missingOrders.join(', ')}`);

  const charges = await setting<{ pixKey?: string; ownerUserId?: string | null }>('charges.config');
  check(Boolean(charges?.pixKey), 'Cobrança', 'Chave Pix definida', 'Sem chave Pix (Cobrança → Configurações): lembrete e vence hoje ficam bloqueados', 'atenção');
  check(Boolean(charges?.ownerUserId), 'Cobrança', 'Responsável pelas conversas de cobrança definida', 'Ninguém definido para as conversas de cobrança (pelo documento, a Ellen)', 'atenção');

  const team = await db.user.findMany({ where: { active: true }, select: { role: true, phone: true, alertSystem: true } });
  check(team.length > 1, 'Equipe', `${team.length} acesso(s) ativo(s)`, 'Só um acesso: cadastre a Ellen, a Duda e a Gabi em Equipe', 'atenção');
  check(team.some((u) => u.role === 'ADMIN' && u.phone && u.alertSystem), 'Equipe', 'Alertas do sistema vão para o WhatsApp de um administrador', 'Nenhum administrador com WhatsApp em Equipe: se algo parar, ninguém é avisado no celular', 'atenção');
  check(approved.has('equipe_alerta_sistema'), 'Equipe', 'Template de alerta do sistema aprovado', 'Template equipe_alerta_sistema não aprovado (Equipe → Criar templates dos avisos)', 'atenção');

  const site = await setting<{ tokenHash?: string | null; webhookUrl?: string; lastUsedAt?: string | null }>('site.integration');
  check(Boolean(site?.tokenHash), 'Site', site?.lastUsedAt ? 'Chave do site gerada e já usada' : 'Chave do site gerada', 'Chave do site não gerada (Integração com o site)', 'atenção');
  check(Boolean(site?.webhookUrl), 'Site', `Avisos para ${site?.webhookUrl}`, 'URL dos avisos para o site não configurada', 'atenção');
  check(Boolean(env.META_APP_ID), 'Meta', 'META_APP_ID definido', 'META_APP_ID vazio: templates com PDF/imagem (fornecedores, campanha do painel) não podem ser criados', 'atenção');

  const knowledge = await getKnowledge(db, env);
  // nome curto de cada item ("Frete e prazo de entrega: [DEFINIR]" → "Frete e prazo de entrega"); ignora a linha que só explica a regra
  const pending = pendingPlaceholders(knowledge.content)
    .map((l) => l.split(':')[0]!.replace(/^[-*#>\s]+/, '').replace(/\*/g, '').trim())
    .filter((l) => l && l.length <= 60);
  check(pending.length === 0, 'Bot', 'Base de conhecimento sem [DEFINIR]', `Base de conhecimento com ${pending.length} item(ns) [DEFINIR]: ${pending.slice(0, 6).join(' · ')}${pending.length > 6 ? ' …' : ''}`, 'atenção');
}

async function main() {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.log(`✘ .env inválido:\n${(err as Error).message}`);
    process.exit(1);
  }
  envChecks(env);
  const db = new PrismaClient();
  try {
    await Promise.race([db.$connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), 5000))]);
    await dbChecks(env, db);
  } catch (err) {
    add('atenção', 'Banco', `Não foi possível consultar o banco (${(err as Error).message}); itens do painel não conferidos`);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }

  const icon: Record<Level, string> = { ok: '✔', falta: '✘', atenção: '!' };
  console.log('\nOliver WhatsApp Hub — checklist\n');
  for (const area of [...new Set(rows.map((r) => r.area))]) {
    console.log(area);
    for (const r of rows.filter((x) => x.area === area)) console.log(`  ${icon[r.level]} ${r.text}`);
  }
  const missing = rows.filter((r) => r.level === 'falta').length;
  const warn = rows.filter((r) => r.level === 'atenção').length;
  console.log(`\n${missing} obrigatório(s) pendente(s), ${warn} ponto(s) de atenção.`);
  process.exit(missing ? 1 : 0);
}

void main();
