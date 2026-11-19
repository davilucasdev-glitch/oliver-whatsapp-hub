import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  BlingBordero,
  BlingReceivable,
  BlingCategory,
  BlingContact,
  BlingOrderDetail,
  BlingProductDetail,
  BlingSituation,
} from '../bling/types.js';

/**
 * Simulador da API v3 do Bling para dev local e testes (nada aqui toca a conta real).
 * - OAuth: /Api/v3/oauth/authorize aprova na hora e volta para o redirect_uri com ?code=
 *   /Api/v3/oauth/token troca code/refresh_token (o refresh_token gira a cada uso, como no Bling).
 * - Produtos, categorias, contatos, pedidos e situações com dados de exemplo no formato real.
 */

export interface MockBling {
  url: string;
  app: FastifyInstance;
  clientId: string;
  clientSecret: string;
  products: BlingProductDetail[];
  categories: BlingCategory[];
  contacts: BlingContact[];
  orders: BlingOrderDetail[];
  situations: BlingSituation[];
  /** formas de pagamento (id → descrição) */
  paymentMethods: { id: number; descricao: string }[];
  /** "2026-11-18 14:05:00" (horário de Brasília) da última alteração de cada pedido, por id */
  alteredAt: Map<number, string>;
  /** Muda a situação (e o que mais vier) de um pedido, como a equipe faria no Kanban. */
  updateOrder(numero: number, patch: Partial<BlingOrderDetail> & { situacaoId?: number }): BlingOrderDetail;
  /** Pedidos de compra (fornecedores) */
  purchaseOrders: Record<string, unknown>[];
  /** Contas a receber (datas relativas a hoje, recriadas no reset) */
  receivables: BlingReceivable[];
  borderos: BlingBordero[];
  /** data (AAAA-MM-DD) em que cada conta foi recebida, por id */
  receivedOn: Map<number, string>;
  /** Dá baixa: sem valor = recebida inteira; com valor = parcial (cria um borderô). */
  payReceivable(id: number, amount?: number): void;
  /** Cria um pedido novo (Em aberto) e devolve. */
  addOrder(o: Partial<BlingOrderDetail> & { numero: number; contato: BlingOrderDetail['contato'] }): BlingOrderDetail;
  accessToken: string | null;
  refreshToken: string | null;
  /** chamadas recebidas (método + caminho) */
  calls: string[];
  /** próximas N respostas da API com este status (ex.: 429) */
  failNext?: { status: number; times: number };
  /** faz o próximo /token de refresh responder invalid_grant */
  rejectRefresh: boolean;
  /** invalida o access_token atual (a próxima chamada recebe 401) */
  expireAccessToken(): void;
  reset(): void;
  close(): Promise<void>;
}

const ficha = (title: string, resumo: string, genero: string, conc: string, familia: string, notas: [string, string, string], inspirado?: string) =>
  `<h2>${title}</h2>\n<p>${resumo}</p>\n<h3>Ficha Olfativa</h3>\n<ul>\n<li><strong>G&ecirc;nero:</strong> ${genero}</li>\n` +
  `<li><strong>Concentra&ccedil;&atilde;o:</strong> ${conc} &middot; 100ml</li>\n<li><strong>Fam&iacute;lia Olfativa:</strong> ${familia}</li>\n</ul>\n` +
  `<h3>Pir&acirc;mide de Notas</h3>\n<ul>\n<li><strong>Notas de Topo:</strong> ${notas[0]}</li>\n<li><strong>Notas de Cora&ccedil;&atilde;o:</strong> ${notas[1]}</li>\n` +
  `<li><strong>Notas de Fundo:</strong> ${notas[2]}</li>\n</ul>${inspirado ? `\n<p><em>Inspirado em ${inspirado}.</em></p>` : ''}`;

function defaultData(base: string) {
  const img = (id: number) => `${base}/img/${id}.svg`;
  const categories: BlingCategory[] = [
    { id: 100, descricao: 'Perfumaria', categoriaPai: { id: 0 } },
    { id: 101, descricao: 'Produtos Masculinos', categoriaPai: { id: 100 } },
    { id: 102, descricao: 'Produtos Femininos', categoriaPai: { id: 100 } },
    { id: 103, descricao: 'Árabes', categoriaPai: { id: 100 } },
    { id: 200, descricao: 'Kits', categoriaPai: { id: 0 } },
  ];
  const p = (o: Partial<BlingProductDetail> & { id: number; nome: string }): BlingProductDetail => ({
    codigo: '',
    preco: 0,
    tipo: 'P',
    situacao: 'A',
    formato: 'S',
    descricaoCurta: '',
    imagemURL: img(o.id),
    estoque: { saldoVirtualTotal: 0 },
    midia: { imagens: { internas: [{ link: `${img(o.id)}?full=1`, validade: '2099-01-01 00:00:00' }], externas: [] } },
    ...o,
  });
  const products: BlingProductDetail[] = [
    p({
      id: 1001,
      nome: 'LATTAFA ASAD EDP 100ML',
      codigo: 'LAT-ASAD',
      preco: 189.9,
      estoque: { saldoVirtualTotal: 7 },
      categoria: { id: 103 },
      descricaoCurta: ficha('LATTAFA ASAD EDP 100ML', 'Masculino intenso e ambarado, com pimenta preta e baunilha. Ótimo para a noite.', 'Masculino', 'Eau de Parfum (EDP)', 'Âmbar Especiada', ['pimenta preta, abacaxi', 'café, íris', 'baunilha, âmbar, benjoim'], 'Sauvage Elixir (Dior)'),
    }),
    p({
      id: 1002,
      nome: 'LATTAFA YARA EDP 100ML FEM',
      codigo: 'LAT-YARA',
      preco: 179.9,
      estoque: { saldoVirtualTotal: 0 },
      categoria: { id: 103 },
      descricaoCurta: ficha('LATTAFA YARA EDP 100ML', 'Feminino doce e cremoso, com orquídea, frutas tropicais e baunilha.', 'Feminino', 'Eau de Parfum (EDP)', 'Oriental Gourmand', ['orquídea, heliotrópio, tangerina', 'acorde gourmand, frutas tropicais', 'baunilha, almíscar, sândalo']),
    }),
    p({
      id: 1003,
      nome: 'AB THE ICON ELIXIR EDP MASC 100ML',
      codigo: 'icon100',
      preco: 245,
      estoque: { saldoVirtualTotal: 3 },
      categoria: { id: 101 },
      descricaoCurta: ficha('ANTONIO BANDERAS THE ICON ELIXIR EDP 100ML', 'Masculino intenso e moderno, com tangerina, cardamomo e gengibre.', 'Masculino', 'Eau de Parfum (EDP)', 'Amadeirada Aromática', ['tangerina, cardamomo, gengibre', 'lavanda, gerânio, notas salgadas', 'guaiaco, cedro, âmbar, almíscar']),
      // HTML "sujo" colado de site, como acontece de verdade no descricaoComplementar
      descricaoComplementar:
        '<div style="font-family: Arial" data-x="1"><span>O </span><span style="font-weight:bold">The Icon Elixir<!--TgQPHd|||[]--></span>, da marca &lt;a href="https://exemplo.com"&gt;Antonio Banderas&lt;/a&gt;, possui fragrância <mark>amadeirada especiada</mark>. [<a href="#">1</a>, <a href="#">2</a>]</div>',
    }),
    p({
      id: 1004,
      nome: 'Cupcake Lattafa Morango 30ml',
      codigo: 'Cupmorango',
      preco: 55,
      estoque: { saldoVirtualTotal: 12 },
      categoria: { id: 102 },
      descricaoCurta: '',
      descricaoComplementar: '<p>Body splash <b>feminino</b> de morango &amp; chantilly.</p>',
    }),
    p({
      id: 1005,
      nome: 'KIT CARLOTTA BLEU DE CARLOTTA- MASC',
      codigo: 'KITCARBLEU',
      preco: 145,
      formato: 'E',
      estoque: { saldoVirtualTotal: 2 },
      categoria: { id: 200 },
      descricaoCurta: '<p>Kit com perfume 100ml + desodorante.</p>',
    }),
    p({ id: 1006, nome: 'PRODUTO FORA DE LINHA', codigo: 'OLD-1', preco: 10, situacao: 'I', categoria: { id: 100 } }),
  ];
  const contacts: BlingContact[] = [
    { id: 5001, nome: 'Maria Souza', numeroDocumento: '529.982.247-25', celular: '(11) 98888-7777', telefone: '', email: 'maria@exemplo.com' },
    { id: 5002, nome: 'João Lima', numeroDocumento: '11144477735', celular: '', telefone: '(21) 97777-6666', email: '' },
    { id: 5003, nome: 'ANA PAULA SILVA', numeroDocumento: '', celular: '', telefone: '', email: '' },
    {
      id: 5010,
      nome: 'BEAUTY MANIA PERFUMES E COSMETICOS LTDA',
      numeroDocumento: '44782347000109',
      celular: '(45) 99104-0157',
      telefone: '(45) 99104-0157',
      email: '',
      tiposContato: [{ id: 14573736006, descricao: 'Fornecedor' }],
    },
    { id: 5011, nome: 'DISTRIBUIDORA SEM TELEFONE LTDA', numeroDocumento: '11222333000181', celular: '', telefone: '', email: '', tiposContato: [{ id: 14573736006, descricao: 'Fornecedor' }] },
  ];
  const item = (prod: BlingProductDetail, qtd: number) => ({ codigo: prod.codigo, descricao: prod.nome, quantidade: qtd, valor: prod.preco ?? 0, produto: { id: prod.id } });
  const [asad, , icon, cupcake] = products as [BlingProductDetail, BlingProductDetail, BlingProductDetail, BlingProductDetail];
  const orders: BlingOrderDetail[] = [
    {
      id: 9001,
      numero: 8801,
      numeroLoja: '',
      data: '2026-11-10',
      dataSaida: '2026-11-11',
      dataPrevista: '0000-00-00',
      total: 244.9,
      totalProdutos: 244.9,
      contato: { id: 5001, nome: 'Maria Souza', numeroDocumento: '529.982.247-25', tipoPessoa: 'F' },
      situacao: { id: 9, valor: 1 },
      loja: { id: 206151954 },
      observacoes: 'Pedido pelo site · Entrega · Pix',
      parcelas: [{ dataVencimento: '2026-11-10', valor: 244.9, formaPagamento: { id: 3781999 } }],
      itens: [item(asad, 1), item(cupcake, 1)],
      transporte: { frete: 0, contato: { id: 7001, nome: 'Correios' }, volumes: [{ id: 1, servico: 'SEDEX', codigoRastreamento: 'AB123456789BR' }] },
      notaFiscal: { id: 3001 },
    },
    {
      id: 9002,
      numero: 8805,
      numeroLoja: 'LOJA-77',
      data: '2026-11-14',
      dataSaida: '0000-00-00',
      dataPrevista: '2026-11-20',
      total: 245,
      totalProdutos: 245,
      contato: { id: 5001, nome: 'Maria Souza', numeroDocumento: '52998224725', tipoPessoa: 'F' },
      situacao: { id: 777, valor: 0 },
      loja: { id: 206093178 },
      itens: [item(icon, 1)],
      transporte: { frete: 0, contato: { id: 0, nome: '' }, volumes: [] },
      notaFiscal: { id: 0 },
    },
    {
      id: 9003,
      numero: 8806,
      numeroLoja: '',
      data: '2026-11-14',
      dataSaida: '0000-00-00',
      dataPrevista: '0000-00-00',
      total: 55,
      contato: { id: 5002, nome: 'João Lima', numeroDocumento: '11144477735', tipoPessoa: 'F' },
      situacao: { id: 6, valor: 0 },
      loja: { id: 205798284 },
      itens: [item(cupcake, 1)],
      transporte: { volumes: [] },
      notaFiscal: { id: 0 },
    },
  ];
  const situations: BlingSituation[] = [
    { id: 777, nome: 'Aguardando envio', idHerdado: 15 },
    // mesmos ids da conta real da Oliver
    { id: 947772, nome: 'Separando', idHerdado: 15 },
    { id: 947773, nome: 'Emitir Etiqueta', idHerdado: 15 },
    { id: 947779, nome: 'Enviado', idHerdado: 15 },
    { id: 31, nome: 'Em andamento' },
    { id: 34, nome: 'Atendido' },
  ];
  const paymentMethods = [
    { id: 3781999, descricao: 'Pix' },
    { id: 8238338, descricao: 'Cartão de crédito' },
  ];
  const today = nowBling().slice(0, 10);
  const day = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const maria = { id: 5001, nome: 'Maria Souza', numeroDocumento: '52998224725' };
  const joao = { id: 5002, nome: 'João Lima', numeroDocumento: '11144477735' };
  const ana = { id: 5003, nome: 'ANA PAULA SILVA', numeroDocumento: '' };
  const rc = (id: number, contato: typeof maria, valor: number, venc: number, origem: number | null, extra: Partial<BlingReceivable> = {}): BlingReceivable => ({
    id,
    situacao: 1,
    vencimento: day(venc),
    valor,
    dataEmissao: '2026-10-05',
    contato,
    formaPagamento: { id: 3781999 },
    idOrigem: origem ?? 0,
    origem: origem ? { id: origem, numero: String(orders.find((o) => o.id === origem)?.numero ?? ''), tipoOrigem: 'venda' } : { id: 0, numero: '', tipoOrigem: '' },
    ...extra,
  });
  const receivables: BlingReceivable[] = [
    rc(7001, maria, 278, 2, 9001), // lembrete (vence em 2 dias)
    rc(7002, maria, 278, 32, 9001), // ainda não venceu (entra no saldo)
    rc(7003, joao, 55, 0, 9003), // vence hoje
    rc(7004, joao, 100, -5, 9003), // 5 dias de atraso
    rc(7005, ana, 80, -3, null), // atraso, mas sem telefone
    rc(7006, maria, 245, -10, 9002), // pedido da loja TikTok: fora
    rc(7007, maria, 90, -20, 9001, { dataEmissao: '2026-09-20' }), // emitida antes do corte: fora
    rc(7008, maria, 300, -8, 9001, { situacao: 3, borderos: [8001] }), // parcial: pagou 100, faltam 200
    rc(7009, joao, 150, -2, 9003, { situacao: 3 }), // parcial sem informação de quanto falta
  ];
  const borderos: BlingBordero[] = [{ id: 8001, data: day(-6), pagamentos: [{ contato: { id: 5001 }, valorPago: 100 }] }];
  const purchaseOrders = [
    {
      id: 9501,
      numero: 191,
      data: day(-2),
      dataPrevista: '0000-00-00',
      fornecedor: { id: 5010 },
      situacao: { id: 31, valor: 1 },
      totalProdutos: 1013.66,
      total: 1013.66,
      observacoes: 'Compra urgente · gerado pelo painel da Oliver',
      transporte: { frete: 0 },
      itens: [
        { descricao: 'BRAND COLLECTION 477 - INSPIRAÇAO LA BOMBA - 25ML', codigoFornecedor: '', produto: { id: 1, codigo: 'bc477' }, quantidade: 12, unidade: 'UN', valor: 28.8 },
        { descricao: 'LATTAFA Thahwah 100ML', codigoFornecedor: '', produto: { id: 2, codigo: 'LATTAFATHAHWAH' }, quantidade: 2, unidade: 'UN', valor: 265.82 },
        { descricao: 'ARMAF CLUB DE NUIT INTENSE MAN EDT 105ML', codigoFornecedor: '', produto: { id: 3, codigo: 'ARMAFPRETO' }, quantidade: 1, unidade: 'UN', valor: 136.42 },
      ],
    },
    {
      id: 9502,
      numero: 190,
      data: day(-5),
      dataPrevista: '0000-00-00',
      fornecedor: { id: 5011 },
      situacao: { id: 34, valor: 2 },
      totalProdutos: 300,
      total: 300,
      observacoes: '',
      transporte: { frete: 0 },
      itens: [{ descricao: 'Produto X', produto: { id: 4, codigo: 'X1' }, quantidade: 10, unidade: 'UN', valor: 30 }],
    },
  ];
  return { products, categories, contacts, orders, situations, paymentMethods, receivables, borderos, purchaseOrders };
}

const listFields = (p: BlingProductDetail) => ({
  id: p.id,
  idProdutoPai: p.idProdutoPai,
  nome: p.nome,
  codigo: p.codigo,
  preco: p.preco,
  tipo: p.tipo,
  situacao: p.situacao,
  formato: p.formato,
  descricaoCurta: p.descricaoCurta,
  imagemURL: p.imagemURL,
  estoque: { saldoVirtualTotal: p.estoque?.saldoVirtualTotal ?? 0 },
});

const digits = (s?: string) => (s ?? '').replace(/\D/g, '');

/** Mesmo formato e fuso do filtro dataAlteracaoInicial do Bling. */
function nowBling(d = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

export async function startMockBling(port = 0, log = false): Promise<MockBling> {
  const app = Fastify({ logger: false });
  let seq = 0;
  let issuedCode: string | null = null;
  const state: MockBling = {
    url: '',
    app,
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    products: [],
    categories: [],
    contacts: [],
    orders: [],
    situations: [],
    paymentMethods: [],
    alteredAt: new Map(),
    receivables: [],
    borderos: [],
    purchaseOrders: [],
    receivedOn: new Map(),
    payReceivable(id, amount) {
      const r = state.receivables.find((x) => x.id === id);
      if (!r) throw new Error(`conta ${id} não existe no Bling simulado`);
      const paidBefore = (r.borderos ?? []).reduce<number>((acc, b) => acc + (state.borderos.find((x) => x.id === (typeof b === 'number' ? b : b.id))?.pagamentos?.[0]?.valorPago ?? 0), 0);
      const pay = amount ?? r.valor - paidBefore;
      const bid = 8000 + state.borderos.length + 1;
      state.borderos.push({ id: bid, data: nowBling().slice(0, 10), pagamentos: [{ contato: { id: r.contato.id }, valorPago: pay }] });
      r.borderos = [...(r.borderos ?? []), bid];
      const done = paidBefore + pay >= r.valor - 0.009;
      r.situacao = done ? 2 : 3;
      if (done) state.receivedOn.set(r.id, nowBling().slice(0, 10));
    },
    updateOrder(numero, patch) {
      const o = state.orders.find((x) => x.numero === numero);
      if (!o) throw new Error(`pedido ${numero} não existe no Bling simulado`);
      const { situacaoId, ...rest } = patch;
      Object.assign(o, rest);
      if (situacaoId) o.situacao = { id: situacaoId, valor: 0 };
      state.alteredAt.set(o.id, nowBling());
      return o;
    },
    addOrder(input) {
      const o: BlingOrderDetail = {
        id: 9000 + input.numero,
        numeroLoja: '',
        data: nowBling().slice(0, 10),
        dataSaida: '0000-00-00',
        dataPrevista: '0000-00-00',
        total: 100,
        situacao: { id: 6, valor: 0 },
        itens: [],
        transporte: { frete: 0, volumes: [] },
        notaFiscal: { id: 0 },
        ...input,
      };
      state.orders.push(o);
      state.alteredAt.set(o.id, nowBling());
      return o;
    },
    accessToken: null,
    refreshToken: null,
    calls: [],
    rejectRefresh: false,
    expireAccessToken() {
      state.accessToken = `expirado-${++seq}`;
    },
    reset() {
      Object.assign(state, defaultData(`${state.url}/Api/v3`));
      // pedidos de exemplo "alterados" há 2 dias (entram na foto inicial dos avisos)
      state.alteredAt = new Map(state.orders.map((o) => [o.id, nowBling(new Date(Date.now() - 2 * 86_400_000))]));
      state.receivedOn = new Map();
      state.accessToken = null;
      state.refreshToken = null;
      state.calls.length = 0;
      state.failNext = undefined;
      state.rejectRefresh = false;
    },
    close: () => app.close(),
  };

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  const issue = () => {
    state.accessToken = `access-${++seq}`;
    state.refreshToken = `refresh-${++seq}`;
    return { access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 21600, token_type: 'Bearer', scope: '98309 318257570' };
  };

  app.get<{ Querystring: { client_id?: string; state?: string; redirect_uri?: string } }>('/Api/v3/oauth/authorize', async (req, reply) => {
    if (req.query.client_id !== state.clientId) return reply.code(400).send('client_id inválido');
    issuedCode = `code-${++seq}`;
    const to = new URL(req.query.redirect_uri ?? 'http://localhost:3000/api/bling/callback');
    to.searchParams.set('code', issuedCode);
    to.searchParams.set('state', req.query.state ?? '');
    if (log) console.log('[mock-bling] autorização aprovada → redirecionando');
    return reply.redirect(to.toString());
  });

  app.post<{ Body: Record<string, string> }>('/Api/v3/oauth/token', async (req, reply) => {
    const expected = `Basic ${Buffer.from(`${state.clientId}:${state.clientSecret}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return reply.code(401).send({ error: { type: 'invalid_client', message: 'invalid_client', description: 'Credenciais do app inválidas' } });
    const b = req.body;
    if (b.grant_type === 'authorization_code' && b.code && b.code === issuedCode) {
      issuedCode = null;
      return issue();
    }
    if (b.grant_type === 'refresh_token' && !state.rejectRefresh && b.refresh_token && b.refresh_token === state.refreshToken) {
      if (log) console.log('[mock-bling] token renovado');
      return issue();
    }
    return reply.code(400).send({ error: { type: 'invalid_grant', message: 'invalid_grant', description: 'Código ou refresh token inválido' } });
  });

  // Imagem de exemplo (SVG com as iniciais) para o painel ter o que mostrar
  app.get<{ Params: { file: string } }>('/Api/v3/img/:file', async (req, reply) => {
    const id = Number(req.params.file.replace(/\D/g, ''));
    const prod = state.products.find((x) => x.id === id);
    const label = (prod?.nome ?? '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
    reply.type('image/svg+xml');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#efe7f1"/><text x="50%" y="54%" text-anchor="middle" font-family="Georgia" font-size="72" fill="#5b2a5e">${label}</text></svg>`;
  });

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    state.calls.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.headers.authorization !== `Bearer ${state.accessToken}` || !state.accessToken) {
      return reply.code(401).send({ error: { type: 'invalid_token', message: 'invalid_token', description: 'Token inválido ou expirado' } });
    }
    if (state.failNext && state.failNext.times > 0) {
      state.failNext.times--;
      const status = state.failNext.status;
      if (state.failNext.times === 0) state.failNext = undefined;
      return reply
        .code(status)
        .send({ error: { type: status === 429 ? 'TOO_MANY_REQUESTS' : 'SERVER_ERROR', message: status === 429 ? 'Limite de requisições atingido' : 'Erro interno' } });
    }
  };

  /** Só para demonstração local: POST /dev/contas/7004/baixa {"valor":50} (sem valor = inteira) */
  app.post<{ Params: { id: string }; Body: { valor?: number } }>('/dev/contas/:id/baixa', async (req, reply) => {
    try {
      state.payReceivable(Number(req.params.id), req.body?.valor);
      return { data: state.receivables.find((x) => String(x.id) === req.params.id) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Só para demonstração local: POST /dev/pedidos/8806 {"situacaoId":947772} */
  app.post<{ Params: { numero: string }; Body: Partial<BlingOrderDetail> & { situacaoId?: number } }>('/dev/pedidos/:numero', async (req, reply) => {
    try {
      const n = Number(req.params.numero);
      const o = state.orders.some((x) => x.numero === n) ? state.updateOrder(n, req.body ?? {}) : null;
      return o ? { data: o } : reply.code(404).send({ error: 'pedido não existe' });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  await app.register(async (api) => {
    api.addHook('onRequest', guard);
    const page = <T>(items: T[], q: { pagina?: string; limite?: string }) => {
      const limite = Math.min(Number(q.limite ?? 100), 100);
      const pagina = Math.max(Number(q.pagina ?? 1), 1);
      return { data: items.slice((pagina - 1) * limite, pagina * limite) };
    };
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { type: 'RESOURCE_NOT_FOUND', message: 'Recurso não encontrado' } });

    api.get<{ Querystring: Record<string, string> }>('/produtos', async (req) => {
      const crit = req.query.criterio ?? '1';
      const items = state.products.filter((p) => (crit === '2' ? p.situacao === 'A' : crit === '3' ? p.situacao === 'I' : true));
      return page(items.map(listFields), req.query);
    });
    api.get<{ Params: { id: string } }>('/produtos/:id', async (req, reply) => {
      const p = state.products.find((x) => String(x.id) === req.params.id);
      return p ? { data: p } : notFound(reply);
    });
    api.get<{ Querystring: Record<string, string> }>('/categorias/produtos', async (req) => page(state.categories, req.query));

    api.get<{ Querystring: Record<string, string> }>('/contatos', async (req) => {
      let items = state.contacts;
      if (req.query.numeroDocumento) items = items.filter((c) => digits(c.numeroDocumento) === digits(req.query.numeroDocumento));
      if (req.query.pesquisa) {
        const q = req.query.pesquisa.toLowerCase();
        const qd = digits(q);
        items = items.filter(
          (c) =>
            c.nome.toLowerCase().includes(q) ||
            (qd && [c.numeroDocumento, c.celular, c.telefone].some((v) => digits(v).includes(qd))),
        );
      }
      // a listagem real traz poucos campos; o telefone completo fica no detalhe
      return page(items.map((c) => ({ id: c.id, nome: c.nome, codigo: c.codigo ?? '', situacao: 'A', numeroDocumento: c.numeroDocumento })), req.query);
    });
    api.get<{ Params: { id: string } }>('/contatos/:id', async (req, reply) => {
      const c = state.contacts.find((x) => String(x.id) === req.params.id);
      return c ? { data: c } : notFound(reply);
    });

    api.get<{ Querystring: Record<string, string> }>('/pedidos/vendas', async (req) => {
      let items = state.orders;
      if (req.query.idContato) items = items.filter((o) => String(o.contato.id) === req.query.idContato);
      if (req.query.numero) items = items.filter((o) => String(o.numero) === req.query.numero);
      const since = req.query.dataAlteracaoInicial;
      if (since) items = items.filter((o) => (state.alteredAt.get(o.id) ?? '') >= since);
      return page(
        items.map(({ itens: _i, transporte: _t, notaFiscal: _n, ...rest }) => rest),
        req.query,
      );
    });
    api.get<{ Params: { id: string } }>('/pedidos/vendas/:id', async (req, reply) => {
      const o = state.orders.find((x) => String(x.id) === req.params.id);
      return o ? { data: o } : notFound(reply);
    });
    api.get('/situacoes/modulos', async () => ({
      data: [
        { id: 98310, nome: 'Vendas', descricao: 'Pedidos de Venda', criarSituacoes: true },
        { id: 575904, nome: 'PedidosCompra', descricao: 'Pedidos de Compra', criarSituacoes: true },
      ],
    }));
    api.get<{ Params: { id: string } }>('/situacoes/modulos/:id', async (req, reply) => {
      if (req.params.id !== '98310') return notFound(reply);
      const standard = [
        { id: 6, nome: 'Em aberto' },
        { id: 9, nome: 'Atendido' },
        { id: 12, nome: 'Cancelado' },
        { id: 15, nome: 'Em andamento' },
        { id: 21, nome: 'Em digitação' },
      ];
      return { data: [...standard, ...state.situations.map((x) => ({ id: x.id, nome: x.nome }))] };
    });
    api.get<{ Querystring: Record<string, string | string[]> }>('/contas/receber', async (req) => {
      const q = req.query;
      const raw = q['situacoes[]'] ?? q.situacoes;
      const sits = raw === undefined ? null : (Array.isArray(raw) ? raw : [raw]).map(Number);
      const tipo = String(q.tipoFiltroData ?? 'E');
      const ini = q.dataInicial ? String(q.dataInicial) : null;
      const fim = q.dataFinal ? String(q.dataFinal) : null;
      const items = state.receivables.filter((r) => {
        if (sits && !sits.includes(r.situacao)) return false;
        const d = tipo === 'V' ? r.vencimento : tipo === 'R' ? (state.receivedOn.get(r.id) ?? '') : r.dataEmissao;
        if (ini && d < ini) return false;
        if (fim && d > fim) return false;
        return true;
      });
      // a listagem real não traz borderôs nem saldo
      return page(items.map(({ borderos: _b, saldo: _s, ...rest }) => rest), q as Record<string, string>);
    });
    api.get<{ Params: { id: string } }>('/contas/receber/:id', async (req, reply) => {
      const r = state.receivables.find((x) => String(x.id) === req.params.id);
      return r ? { data: r } : notFound(reply);
    });
    api.get<{ Querystring: Record<string, string> }>('/pedidos/compras', async (req) => {
      const q = req.query;
      const items = state.purchaseOrders.filter((o) => (!q.dataInicial || String(o.data) >= q.dataInicial) && (!q.dataFinal || String(o.data) <= q.dataFinal));
      return page(items.map(({ itens: _i, observacoes: _o, transporte: _t, ...rest }) => rest), q);
    });
    api.get<{ Params: { id: string } }>('/pedidos/compras/:id', async (req, reply) => {
      const o = state.purchaseOrders.find((x) => String(x.id) === req.params.id);
      return o ? { data: o } : notFound(reply);
    });
    api.get<{ Params: { id: string } }>('/borderos/:id', async (req, reply) => {
      const b = state.borderos.find((x) => String(x.id) === req.params.id);
      return b ? { data: b } : notFound(reply);
    });
    api.get<{ Params: { id: string } }>('/formas-pagamentos/:id', async (req, reply) => {
      const f = state.paymentMethods.find((x) => String(x.id) === req.params.id);
      return f ? { data: f } : notFound(reply);
    });
    api.get<{ Params: { id: string } }>('/situacoes/:id', async (req, reply) => {
      const s = state.situations.find((x) => String(x.id) === req.params.id);
      return s ? { data: s } : notFound(reply);
    });
  }, { prefix: '/Api/v3' });

  const address = await app.listen({ port, host: '127.0.0.1' });
  state.url = address;
  state.reset();
  return state;
}
