import Fastify, { type FastifyInstance } from 'fastify';

/**
 * "Claude" simulado para dev/testes: responde POST /v1/messages no formato da API, com regras simples
 * (não é IA). Serve para exercitar o circuito inteiro (ferramentas, transferência, fotos, logs) sem chave.
 * Também confere o que a API real exigiria: ids de tool_result batendo com o tool_use anterior,
 * blocos de thinking devolvidos sem alteração e o system prompt com cache_control.
 */

type Block = { type: string; [k: string]: unknown };
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

export interface MockClaude {
  url: string;
  app: FastifyInstance;
  requests: { body: Record<string, unknown> }[];
  /** erros de formato detectados (a API real responderia 400) */
  violations: string[];
  /** faz as próximas N chamadas falharem com este status */
  failNext?: { status: number; times: number };
  reset(): void;
  close(): Promise<void>;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

let seq = 0;
const id = (p: string) => `${p}_mock${Date.now().toString(36)}${++seq}`;

function lastUserText(messages: Msg[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return '';
  if (typeof last.content === 'string') return last.content;
  return last.content
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n');
}

function toolResults(messages: Msg[]): { name: string; input: Record<string, unknown>; content: string }[] {
  const last = messages.at(-1);
  const prev = messages.at(-2);
  if (!last || typeof last.content === 'string' || !prev || typeof prev.content === 'string') return [];
  const uses = new Map(prev.content.filter((b) => b.type === 'tool_use').map((b) => [String(b.id), b]));
  return last.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      const use = uses.get(String(b.tool_use_id));
      return { name: String(use?.name ?? '?'), input: (use?.input ?? {}) as Record<string, unknown>, content: String(b.content ?? '') };
    });
}

/** Etapas desta resposta (o mock lembra o que já fez olhando os tool_use anteriores da mesma vez). */
function toolsUsedThisTurn(messages: Msg[]): string[] {
  const names: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (typeof m.content === 'string' || m.content.some((b) => b.type === 'text'))) break;
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      for (const b of m.content) if (b.type === 'tool_use') names.push(String(b.name));
    }
  }
  return names;
}

function decide(messages: Msg[], system: string): { tool?: { name: string; input: Record<string, unknown> }; text?: string } {
  const results = toolResults(messages);
  const used = toolsUsedThisTurn(messages);
  const userText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'user') {
        const t = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
        if (t) return t;
      }
    }
    return '';
  })();
  const t = norm(userText.split('\n').at(-1) ?? userText);
  const closed = system.includes('Atendimento humano: FECHADO');

  if (results.length) {
    const r = results.at(-1)!;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.content) as Record<string, unknown>;
    } catch {
      /* resultado em texto */
    }
    if (r.name === 'buscar_produtos') {
      const list = (data.resultados as { codigo: string; nome: string; preco: string; tem_foto?: boolean; inspirado_em?: string | null }[]) ?? [];
      if (!list.length) return { text: 'Poxa, não encontrei esse produto com estoque agora 😕 Quer que eu procure outro estilo?' };
      if (/foto|imagem/.test(t) && !used.includes('enviar_imagem_produto') && list[0]) {
        return { tool: { name: 'enviar_imagem_produto', input: { sku: list[0].codigo } } };
      }
      const top = list.slice(0, 3).map((p) => `• *${p.nome}* — ${p.preco}${p.inspirado_em ? ` (inspirado em ${p.inspirado_em})` : ''}`);
      return { text: `Separei estas opções para você:\n${top.join('\n')}\n\nQuer saber mais de alguma? ✨` };
    }
    if (r.name === 'enviar_imagem_produto') return { text: data.ok ? 'Mandei a foto aqui em cima 😊 Gostou?' : 'Não consegui mandar a foto agora, desculpe!' };
    if (r.name === 'detalhes_produto') return { text: data.nome ? `O *${String(data.nome)}* sai por ${String(data.preco)}.` : 'Não achei esse produto.' };
    if (r.name === 'consultar_pedido') {
      const pedidos = (data.pedidos as { numero: number; situacao: string; rastreio?: string[] | null }[]) ?? [];
      if (pedidos.length) {
        const p = pedidos[0]!;
        return { text: `Seu pedido *${p.numero}* está como *${p.situacao}*.${p.rastreio?.length ? ` Rastreio: ${p.rastreio.join(', ')}` : ''}` };
      }
      return { text: String(data.resultado ?? data.erro ?? 'Não encontrei o pedido.').includes('CPF') ? 'Me passa o CPF usado na compra, por favor?' : 'Não consegui localizar esse pedido. Quer falar com um atendente?' };
    }
    if (r.name === 'transferir_para_humano') {
      return { text: closed ? 'Prontinho! Nosso time está fora do horário agora, mas um atendente te responde assim que voltar 💜' : 'Prontinho! Um atendente vai continuar com você em instantes 💜' };
    }
    return { text: 'Certo!' };
  }

  if (/atendente|humano|pessoa|reclama|troca|devolu|reembolso/.test(t)) return { tool: { name: 'transferir_para_humano', input: { motivo: 'cliente pediu atendimento humano' } } };
  if (/pedido|rastreio|entrega|cpf/.test(t) || /^\d{11}$/.test(t.replace(/\D/g, ''))) {
    const digits = userText.replace(/\D/g, '');
    const input: Record<string, unknown> = {};
    if (digits.length === 11 || digits.length === 14) input.cpf_cnpj = digits;
    else if (digits.length >= 3 && digits.length <= 8) input.numero_pedido = Number(digits);
    return { tool: { name: 'consultar_pedido', input } };
  }
  if (/^(oi|ola|bom dia|boa tarde|boa noite)\b/.test(t) && t.length < 25) return { text: 'Oi! Tudo bem? 💜 Me conta o que você procura: perfume para você ou para presente?' };
  const consulta = t.replace(/foto|imagem|me manda|mostra|tem|voces|quero|um|uma|de|do|da|\?/g, ' ').replace(/\s+/g, ' ').trim() || t;
  return { tool: { name: 'buscar_produtos', input: { consulta } } };
}

export async function startMockClaude(port = 0, log = false): Promise<MockClaude> {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  const state: MockClaude = {
    url: '',
    app,
    requests: [],
    violations: [],
    reset() {
      state.requests.length = 0;
      state.violations.length = 0;
      state.failNext = undefined;
    },
    close: () => app.close(),
  };

  app.post<{ Body: Record<string, unknown> }>('/v1/messages', async (req, reply) => {
    const body = req.body;
    state.requests.push({ body });
    if (!req.headers['x-api-key'] && !String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      return reply.code(401).send({ type: 'error', error: { type: 'authentication_error', message: 'chave da API ausente' } });
    }
    if (state.failNext && state.failNext.times > 0) {
      state.failNext.times--;
      const status = state.failNext.status;
      if (!state.failNext.times) state.failNext = undefined;
      return reply.code(status).send({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: 'falha simulada' } });
    }

    const messages = (body.messages ?? []) as Msg[];
    const problems: string[] = [];
    if (messages[0]?.role !== 'user') problems.push('messages[0] precisa ser do usuário');
    for (let i = 1; i < messages.length; i++) if (messages[i]!.role === messages[i - 1]!.role) problems.push(`papéis repetidos em messages[${i}]`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (typeof m.content === 'string' || m.role !== 'user') continue;
      for (const b of m.content.filter((x) => x.type === 'tool_result')) {
        const prev = messages[i - 1];
        const ok = prev && typeof prev.content !== 'string' && prev.content.some((x) => x.type === 'tool_use' && x.id === b.tool_use_id);
        if (!ok) problems.push(`tool_result ${String(b.tool_use_id)} sem tool_use correspondente`);
      }
    }
    for (const m of messages) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const b of m.content) if (b.type === 'thinking' && b.signature !== `sig:${String(b.thinking)}`) problems.push('bloco de thinking alterado');
    }
    if (body.tools && Array.isArray(body.system) && !(body.system as Block[]).some((b) => b.cache_control)) problems.push('system sem cache_control');
    if (body.tool_choice && ['any', 'tool'].includes(String((body.tool_choice as Block).type))) problems.push('tool_choice forçado não é aceito no Sonnet 5.5');
    if (problems.length) {
      state.violations.push(...problems);
      return reply.code(400).send({ type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } });
    }

    const system = Array.isArray(body.system) ? (body.system as Block[]).map((b) => String(b.text)).join('\n') : String(body.system ?? '');
    const isSummary = !body.tools;
    const d = isSummary ? { text: `Resumo (simulado): cliente conversou sobre ${norm(lastUserText(messages)).slice(0, 60)}…` } : decide(messages, system);
    const thinking = 'analisando a mensagem do cliente';
    const content: Block[] = [{ type: 'thinking', thinking, signature: `sig:${thinking}` }];
    if (d.text) content.push({ type: 'text', text: d.text });
    if (d.tool) content.push({ type: 'tool_use', id: id('toolu'), name: d.tool.name, input: d.tool.input });
    if (log) console.log(`[mock-claude] ${d.tool ? `→ ${d.tool.name} ${JSON.stringify(d.tool.input)}` : `→ "${d.text?.slice(0, 80)}"`}`);

    const prior = state.requests.length > 1;
    return {
      id: id('msg'),
      type: 'message',
      role: 'assistant',
      model: String(body.model),
      content,
      stop_reason: d.tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 120 + messages.length * 40,
        output_tokens: 60,
        cache_read_input_tokens: prior ? 2400 : 0,
        cache_creation_input_tokens: prior ? 0 : 2400,
      },
    };
  });

  const address = await app.listen({ port, host: '127.0.0.1' });
  state.url = address;
  return state;
}
