/** Formatos (parciais) da API v3 do Bling usados aqui. Conferidos contra uma conta real em 14/11/2026. */

export interface BlingPage<T> {
  data: T[];
}

export interface BlingOne<T> {
  data: T;
}

export interface BlingListProduct {
  id: number;
  idProdutoPai?: number;
  nome: string;
  codigo?: string;
  preco?: number;
  tipo?: string; // P produto, S serviço
  situacao?: string; // A ativo, I inativo
  formato?: string; // S simples, V com variações, E composição
  descricaoCurta?: string;
  imagemURL?: string;
  estoque?: { saldoVirtualTotal?: number };
}

export interface BlingImage {
  link: string;
  linkMiniatura?: string;
  validade?: string;
}

export interface BlingProductDetail extends BlingListProduct {
  categoria?: { id: number };
  descricaoComplementar?: string;
  marca?: string;
  gtin?: string;
  midia?: { imagens?: { internas?: BlingImage[]; externas?: BlingImage[]; imagensURL?: BlingImage[] } };
  variacoes?: BlingListProduct[];
}

export interface BlingCategory {
  id: number;
  descricao: string;
  categoriaPai?: { id: number };
}

export interface BlingContact {
  id: number;
  nome: string;
  codigo?: string;
  situacao?: string;
  numeroDocumento?: string;
  telefone?: string;
  celular?: string;
  email?: string;
  /** só no detalhe: data de nascimento "AAAA-MM-DD" ("0000-00-00" quando vazia) */
  dadosAdicionais?: { dataNascimento?: string; sexo?: string };
  tiposContato?: { id: number; descricao: string }[];
}

export interface BlingOrderListItem {
  id: number;
  numero: number;
  numeroLoja?: string;
  data: string;
  dataSaida?: string;
  dataPrevista?: string;
  total: number;
  totalProdutos?: number;
  contato: { id: number; nome: string; numeroDocumento?: string; tipoPessoa?: string };
  situacao: { id: number; valor?: number };
  loja?: { id: number };
}

export interface BlingOrderDetail extends BlingOrderListItem {
  itens?: { codigo?: string; descricao: string; quantidade: number; valor: number; produto?: { id: number } }[];
  transporte?: {
    frete?: number;
    contato?: { id: number; nome: string };
    volumes?: { id?: number; servico?: string; codigoRastreamento?: string }[];
    prazoEntrega?: number;
  };
  notaFiscal?: { id: number };
  /** Ex.: "Pedido pelo site · Retirar na loja · Pix" — de onde sai "retirada x envio". */
  observacoes?: string;
  /** O site grava aqui o WhatsApp da cliente: "WhatsApp 63992142094". */
  observacoesInternas?: string;
  parcelas?: { dataVencimento?: string; valor: number; formaPagamento?: { id: number } }[];
}

/** Conta a receber (GET /contas/receber). Conferido contra a conta real em 18/11/2026. */
export interface BlingReceivable {
  id: number;
  situacao: number; // 1 em aberto, 2 recebido, 3 parcialmente recebido, 4 devolvido, 5 cancelado
  vencimento: string;
  valor: number;
  dataEmissao: string;
  contato: { id: number; nome: string; numeroDocumento?: string };
  formaPagamento?: { id: number };
  idOrigem?: number;
  origem?: { id: number; numero?: string; tipoOrigem?: string; valor?: number };
  /** Só no detalhe, e não confirmado na documentação: quanto falta (se o Bling mandar). */
  saldo?: number;
  /** Só no detalhe: borderôs (baixas) da conta. */
  borderos?: (number | { id: number })[];
}

/** Borderô = uma baixa (pagamento) no Bling. */
export interface BlingBordero {
  id: number;
  data?: string;
  pagamentos?: { contato?: { id: number }; numeroDocumento?: string; valorPago: number; juros?: number; desconto?: number; acrescimo?: number; tarifa?: number }[];
}

export interface BlingPaymentMethod {
  id: number;
  descricao: string;
}

export interface BlingModule {
  id: number;
  nome: string;
  descricao?: string;
}

export interface BlingSituation {
  id: number;
  nome: string;
  idHerdado?: number;
  cor?: string;
}
