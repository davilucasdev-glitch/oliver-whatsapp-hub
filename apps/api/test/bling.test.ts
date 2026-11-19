import { describe, expect, it } from 'vitest';
import { buildQuery } from '../src/bling/client.js';
import { detectGender, firstSentence, htmlToText, normalizeSearch } from '../src/bling/html.js';
import { isValidDocument, samePhone } from '../src/bling/orders.js';
import { buildSearchText, categoryPaths } from '../src/bling/sync.js';

// Trecho no formato real da "Ficha Olfativa" usada nas descrições da loja
const FICHA =
  '<h2>BEAUTY BRAND 027 ONE MILLION 100ML</h2>\n<p>Masculino especiado e ousado, com tangerina sanguínea, canela e couro.</p>\n' +
  '<h3>Ficha Olfativa</h3>\n<ul>\n<li><strong>Gênero:</strong> Masculino</li>\n<li><strong>Concentração:</strong> Eau de Parfum (EDP) &middot; 100ml</li>\n</ul>\n' +
  '<p><em>Inspirado em 1 Million (Paco Rabanne).</em></p>';

describe('htmlToText', () => {
  it('converte a ficha olfativa em texto com tópicos', () => {
    expect(htmlToText(FICHA)).toBe(
      [
        'BEAUTY BRAND 027 ONE MILLION 100ML',
        'Masculino especiado e ousado, com tangerina sanguínea, canela e couro.',
        'Ficha Olfativa',
        '• Gênero: Masculino',
        '• Concentração: Eau de Parfum (EDP) · 100ml',
        'Inspirado em 1 Million (Paco Rabanne).',
      ].join('\n'),
    );
  });

  it('limpa HTML colado de site: estilos, comentários, tags escapadas e citações', () => {
    const dirty =
      '<div style="font-family: Arial" jsaction="x"><span>O </span><span style="font-weight:bold">The Icon Elixir<!--TgQPHd|||[]--></span>, ' +
      'da marca &lt;a class="H23r4e" href="https://x.com"&gt;Antonio Banderas&lt;/a&gt;, possui fragrância <mark>amadeirada</mark>. ' +
      '[&lt;a href="https://a"&gt;1&lt;/a&gt;, &lt;a href="https://b"&gt;2&lt;/a&gt;]</div>\r\n<div></div>';
    expect(htmlToText(dirty)).toBe('O The Icon Elixir, da marca Antonio Banderas, possui fragrância amadeirada.');
  });

  it('decodifica entidades numéricas e nomeadas', () => {
    expect(htmlToText('<p>Fam&iacute;lia &#233; &#xE7; &amp; &quot;doce&quot;&nbsp;!</p>')).toBe('Família é ç & "doce" !');
  });

  it('remove script/style e devolve vazio para nulo', () => {
    expect(htmlToText('<style>.a{}</style><script>alert(1)</script><p>ok</p>')).toBe('ok');
    expect(htmlToText(null)).toBe('');
  });
});

describe('busca e classificação', () => {
  it('normaliza sem acento e sem pontuação', () => {
    expect(normalizeSearch('Pirâmide  de NOTAS: Coração!')).toBe('piramide de notas coracao');
  });

  it('deduz gênero pela ficha, categoria ou nome', () => {
    expect(detectGender('Gênero: Feminino', null, 'X')).toBe('feminino');
    expect(detectGender('', 'Perfumaria > Produtos Masculinos', 'X')).toBe('masculino');
    expect(detectGender('', null, 'LATTAFA YARA EDP 100ML FEM')).toBe('feminino');
    expect(detectGender('', null, 'KIT BLEU - MASC')).toBe('masculino');
    expect(detectGender('Gênero: Unissex', null, 'X MASC')).toBe('unissex');
    expect(detectGender('', null, 'Hidratante 200ml')).toBeNull();
  });

  it('monta o caminho das categorias', () => {
    const paths = categoryPaths([
      { id: 1, descricao: 'Perfumaria', categoriaPai: { id: 0 } },
      { id: 2, descricao: 'Produtos Femininos', categoriaPai: { id: 1 } },
    ]);
    expect(paths.get('2')).toBe('Perfumaria > Produtos Femininos');
    expect(paths.get('1')).toBe('Perfumaria');
  });

  it('resumo pula o título e corta frases longas', () => {
    expect(firstSentence(htmlToText(FICHA))).toBe('Masculino especiado e ousado, com tangerina sanguínea, canela e couro.');
    expect(firstSentence('Título\n' + 'a'.repeat(300), 50)).toHaveLength(50);
  });

  it('texto de busca junta nome, código e categoria', () => {
    expect(buildSearchText({ name: 'Lattafa Asad', sku: 'LAT-ASAD', category: 'Árabes' })).toBe('lattafa asad lat asad arabes');
  });
});

describe('utilitários de pedidos', () => {
  it('valida CPF e CNPJ', () => {
    expect(isValidDocument('529.982.247-25')).toBe(true);
    expect(isValidDocument('529.982.247-24')).toBe(false);
    expect(isValidDocument('111.111.111-11')).toBe(false);
    expect(isValidDocument('11.222.333/0001-81')).toBe(true);
    expect(isValidDocument('11.222.333/0001-80')).toBe(false);
  });

  it('compara telefones ignorando formato e o 9 extra', () => {
    expect(samePhone('(11) 98888-7777', '+5511988887777')).toBe(true);
    expect(samePhone('+551188887777', '+5511988887777')).toBe(true);
    expect(samePhone('(11) 98888-7776', '+5511988887777')).toBe(false);
    expect(samePhone('(21) 98888-7777', '+5511988887777')).toBe(false);
    expect(samePhone('', '+5511988887777')).toBe(false);
  });

  it('monta query com arrays no formato do Bling', () => {
    expect(buildQuery({ pagina: 1, idsProdutos: [1, 2], vazio: '', nada: undefined })).toBe('?pagina=1&idsProdutos%5B%5D=1&idsProdutos%5B%5D=2');
  });
});
