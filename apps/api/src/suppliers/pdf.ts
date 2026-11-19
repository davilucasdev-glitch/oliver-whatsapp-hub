import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * PDF do pedido de compra com a logo da Oliver (documento da Ellen: "Logo da Oliver em toda
 * imagem, PDF e cabeçalho de template"). Fonte padrão Helvetica (WinAnsi): acentos do português
 * funcionam; símbolos fora disso viram equivalentes simples.
 */

export interface PurchaseOrderForPdf {
  numero: number;
  data: string;
  dataPrevista?: string | null;
  fornecedor: { nome: string; documento?: string | null; telefone?: string | null };
  itens: { codigo?: string | null; descricao: string; quantidade: number; unidade?: string | null; valor: number }[];
  totalProdutos: number;
  frete?: number | null;
  total: number;
  observacoes?: string | null;
}

const WINE = rgb(0.29, 0.08, 0.12);
const GOLD = rgb(0.7, 0.55, 0.25);
const GREY = rgb(0.4, 0.4, 0.4);

const SUBST: Record<string, string> = { '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '•': '-', ' ': ' ' };
/** Só caracteres que a Helvetica padrão (WinAnsi) desenha. */
export function pdfSafe(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, (ch) => SUBST[ch] ?? '');
}

const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const ddmmyyyy = (ymd: string) => (ymd && !ymd.startsWith('0000') ? ymd.split('-').reverse().join('/') : '—');

function logoPath(): string | null {
  for (const p of [path.resolve(process.cwd(), 'assets/logo-oliver.png'), path.resolve(process.cwd(), 'apps/api/assets/logo-oliver.png')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export async function purchaseOrderPdf(po: PurchaseOrderForPdf): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Pedido de compra ${po.numero} - Oliver Cosméticos`);
  doc.setAuthor('Oliver Cosméticos');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const lp = logoPath();
  const logo = lp ? await doc.embedPng(fs.readFileSync(lp)) : null;

  const W = 595.28;
  const H = 841.89;
  const M = 40;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (t: string, x: number, yy: number, size = 10, f = font, color = rgb(0, 0, 0)) => page.drawText(pdfSafe(t), { x, y: yy, size, font: f, color });
  const right = (t: string, xr: number, yy: number, size = 10, f = font) => text(t, xr - f.widthOfTextAtSize(pdfSafe(t), size), yy, size, f);

  // cabeçalho
  if (logo) page.drawImage(logo, { x: M, y: y - 72, width: 72, height: 72 });
  text('Oliver Cosméticos', M + 86, y - 22, 16, bold, WINE);
  text('Pedido de compra', M + 86, y - 40, 11, font, GREY);
  right(`Nº ${po.numero}`, W - M, y - 22, 16, bold);
  right(`Data: ${ddmmyyyy(po.data)}`, W - M, y - 40, 10);
  if (po.dataPrevista && !po.dataPrevista.startsWith('0000')) right(`Previsão: ${ddmmyyyy(po.dataPrevista)}`, W - M, y - 54, 10);
  y -= 90;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: GOLD });
  y -= 22;

  // fornecedor
  text('Fornecedor', M, y, 9, bold, GREY);
  y -= 14;
  text(po.fornecedor.nome, M, y, 11, bold);
  y -= 14;
  const extra = [po.fornecedor.documento ? `CNPJ/CPF ${po.fornecedor.documento}` : null, po.fornecedor.telefone ? `Tel. ${po.fornecedor.telefone}` : null].filter(Boolean).join('   ');
  if (extra) {
    text(extra, M, y, 9, font, GREY);
    y -= 14;
  }
  y -= 10;

  // itens
  // bordas DIREITAS das colunas de número (alinhadas à direita); código e produto à esquerda
  const cols = { cod: M + 4, desc: M + 84, qtdR: W - M - 168, unitR: W - M - 86, totalR: W - M - 4 };
  const descWidth = cols.qtdR - 44 - cols.desc;
  const fit = (t: string, f: PDFFont, size: number, width: number) => {
    let out = pdfSafe(t);
    while (out && f.widthOfTextAtSize(out, size) > width) out = out.slice(0, -1);
    return out.length < pdfSafe(t).length ? `${out.slice(0, -1)}…`.replace('…', '.') : out;
  };
  const header = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 18, color: rgb(0.96, 0.93, 0.9) });
    text('Código', cols.cod, y + 1, 9, bold);
    text('Produto', cols.desc, y + 1, 9, bold);
    right('Qtd', cols.qtdR, y + 1, 9, bold);
    right('Unitário', cols.unitR, y + 1, 9, bold);
    right('Total', cols.totalR, y + 1, 9, bold);
    y -= 22;
  };
  header();
  for (const it of po.itens) {
    const lines = wrap(it.descricao, font, 9, descWidth);
    const h = lines.length * 11 + 9;
    if (y - h < M + 60) {
      page = doc.addPage([W, H]);
      y = H - M;
      header();
    }
    text(fit(it.codigo ?? '', font, 8.5, cols.desc - cols.cod - 8), cols.cod, y, 8.5, font, GREY);
    lines.forEach((l, i) => text(l, cols.desc, y - i * 11, 9));
    right(`${it.quantidade}${it.unidade ? ` ${it.unidade.toLowerCase()}` : ''}`, cols.qtdR, y, 9);
    right(brl(it.valor), cols.unitR, y, 9);
    right(brl(it.valor * it.quantidade), cols.totalR, y, 9);
    y -= h;
    // linha entre os produtos, abaixo da última linha do item (sem riscar o texto)
    page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.4, color: rgb(0.88, 0.88, 0.88) });
  }

  // totais
  if (y < M + 90) {
    page = doc.addPage([W, H]);
    y = H - M;
  }
  y -= 10;
  const qtd = po.itens.reduce((a, i) => a + i.quantidade, 0);
  text(`${po.itens.length} produto(s), ${qtd} unidade(s)`, M, y, 9, font, GREY);
  right(`Produtos: ${brl(po.totalProdutos)}`, W - M - 4, y, 10);
  if (po.frete) {
    y -= 14;
    right(`Frete: ${brl(po.frete)}`, W - M - 4, y, 10);
  }
  y -= 18;
  right(`Total: ${brl(po.total)}`, W - M - 4, y, 13, bold);
  if (po.observacoes?.trim()) {
    y -= 28;
    text('Observações', M, y, 9, bold, GREY);
    for (const l of wrap(po.observacoes, font, 9, W - 2 * M).slice(0, 6)) {
      y -= 12;
      text(l, M, y, 9);
    }
  }

  // rodapé em todas as páginas
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(pdfSafe(`Oliver Cosméticos · pedido de compra nº ${po.numero} · página ${i + 1} de ${pages.length}`), { x: M, y: 24, size: 8, font, color: GREY });
  });
  return Buffer.from(await doc.save());
}
