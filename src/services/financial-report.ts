import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import * as drive from './google-drive';
import * as gmail from './gmail';
import { sendText } from './evolution';
import * as path from 'path';
import * as fs from 'fs';

// Supabase — mesmo banco do Precificação (compartilhado com VitallAssistente)
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// Cores do PDF (padrão Vitall)
const C = {
  teal:       '#277d7e',
  tealDark:   '#1f6364',
  tealLight:  '#d0e8e8',
  gold:       '#c89d68',
  green:      '#059669',
  greenLight: '#d1fae5',
  red:        '#dc2626',
  redLight:   '#fee2e2',
  blue:       '#2563eb',
  blueLight:  '#dbeafe',
  grayText:   '#6b7280',
  grayBorder: '#e5e7eb',
  black:      '#111827',
  white:      '#ffffff',
};

// Caminho da logo
const LOGO_PATH = path.join(__dirname, '../../assets/vitall-logo.png');

// Paleta para gráfico de pizza
const PIE_PALETTE = ['#277d7e','#2563eb','#c89d68','#059669','#7c3aed','#0891b2','#f59e0b','#db2777'];

// ── Types ──

interface LancamentoContaCorrente {
  id: string;
  data: string; // YYYY-MM-DD
  tipo: 'entrada' | 'saida' | 'venda';
  descricao: string;
  contraparte: string;
  valor: number;
}

interface ContaPagar {
  id: string;
  competencia: string; // YYYY-MM
  vencimento: string; // YYYY-MM-DD
  valor: number;
  status: 'aberto' | 'realizado';
  classificacao: string; // "Custo Fixo", "Custo Variável", "Investimento", etc.
  categoria: string;
  descricao: string;
}

// ── Data Fetching ──

/**
 * Busca lançamentos da Conta Corrente para um mês (YYYY-MM).
 * Combina:
 * - lancamentos_conta_corrente (entradas/saídas avulsas)
 * - contas_pagar com status='realizado' (pagamentos efetuados)
 */
async function fetchContaCorrente(yearMonth: string): Promise<LancamentoContaCorrente[]> {
  const [year, month] = yearMonth.split('-');
  const startDate = `${yearMonth}-01`;
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const endDate = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;

  // Buscar lançamentos avulsos (entradas/saídas/vendas do C6 Bank e Clinicorp)
  const { data: lancamentos, error: errLanc } = await supabase
    .from('lancamentos_conta_corrente')
    .select('id, data, tipo, descricao, contraparte, valor')
    .gte('data', startDate)
    .lte('data', endDate)
    .order('data', { ascending: true });

  if (errLanc) {
    console.error('[FinReport] Erro ao buscar lançamentos:', errLanc.message);
  }

  // Buscar contas pagas (status=realizado) — são saídas
  const { data: contas, error: errContas } = await supabase
    .from('contas_pagar')
    .select('id, vencimento, descricao, categoria, valor')
    .eq('status', 'realizado')
    .gte('vencimento', startDate)
    .lte('vencimento', endDate)
    .order('vencimento', { ascending: true });

  if (errContas) {
    console.error('[FinReport] Erro ao buscar contas pagas:', errContas.message);
  }

  const result: LancamentoContaCorrente[] = [];

  // Adicionar lançamentos avulsos
  if (lancamentos) {
    result.push(...lancamentos);
  }

  // Adicionar contas pagas como saídas
  if (contas) {
    for (const c of contas) {
      result.push({
        id: c.id,
        data: c.vencimento,
        tipo: 'saida',
        descricao: `${c.categoria} - ${c.descricao}`,
        contraparte: '',
        valor: c.valor,
      });
    }
  }

  // Ordenar por data
  result.sort((a, b) => a.data.localeCompare(b.data));

  console.log(`[FinReport] Conta Corrente ${yearMonth}: ${result.length} lançamento(s)`);
  return result;
}

/**
 * Busca Contas a Pagar de um mês (por vencimento).
 */
async function fetchContasPagar(yearMonth: string): Promise<ContaPagar[]> {
  const [year, month] = yearMonth.split('-');
  const startDate = `${yearMonth}-01`;
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const endDate = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('contas_pagar')
    .select('id, competencia, vencimento, valor, status, classificacao, categoria, descricao')
    .gte('vencimento', startDate)
    .lte('vencimento', endDate)
    .order('vencimento', { ascending: true });

  if (error) {
    console.error('[FinReport] Erro ao buscar contas a pagar:', error.message);
    return [];
  }

  console.log(`[FinReport] Contas a Pagar ${yearMonth}: ${data?.length || 0} conta(s)`);
  return data || [];
}

// ── PDF Generation ──

/** Formata número como R$ 1.234,56 */
function formatBRL(value: number): string {
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Formata data YYYY-MM-DD para DD/MM/YYYY */
function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/** Retorna o dia da semana abreviado (SEG, TER, etc.) */
function getDayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const days = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
  return days[date.getDay()];
}

/** Colunas proporcionais que somam exatamente pageWidth */
function calcColWidths(percentages: number[], pageWidth: number): number[] {
  const total = percentages.reduce((a, b) => a + b, 0);
  const cols = percentages.map(p => Math.floor((p / total) * pageWidth));
  const sum = cols.reduce((a, b) => a + b, 0);
  cols[cols.length - 1] += pageWidth - sum;
  return cols;
}

/**
 * Header limpo: barra teal fina no topo, fundo branco, logo visível à esquerda,
 * título centralizado em teal, linha teal embaixo.
 * Retorna o Y de onde a tabela começa.
 */
function drawPageHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  monthTitle: string,
  pageWidth: number,
): number {
  const ACCENT_H = 5;
  const HEADER_H = 62;
  const TOTAL_H = ACCENT_H + HEADER_H;
  const LOGO_W = 100;
  const LOGO_H = 42;
  const LOGO_Y = ACCENT_H + (HEADER_H - LOGO_H) / 2;

  doc.rect(0, 0, pageWidth, ACCENT_H).fill(C.teal);
  doc.rect(0, ACCENT_H, pageWidth, HEADER_H).fill(C.white);

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 14, LOGO_Y, { fit: [LOGO_W, LOGO_H] });
  }

  const titleY = ACCENT_H + HEADER_H / 2 - 18;

  doc.fontSize(15).font('Helvetica-Bold').fillColor(C.teal);
  doc.text(title.toUpperCase(), 0, titleY, { width: pageWidth, align: 'center', lineBreak: false });

  doc.fontSize(10).font('Helvetica').fillColor(C.grayText);
  doc.text(`Competência: ${monthTitle}`, 0, titleY + 22, { width: pageWidth, align: 'center', lineBreak: false });

  doc.rect(0, TOTAL_H - 1, pageWidth, 2).fill(C.teal);

  return TOTAL_H + 1;
}

/** Cabeçalho de colunas — teal escuro, texto branco */
function drawTableHeader(
  doc: PDFKit.PDFDocument,
  headers: string[],
  colW: number[],
  y: number,
): number {
  const TW = colW.reduce((a, b) => a + b, 0);
  const thH = 26;

  doc.rect(0, y, TW, thH).fill(C.tealDark);
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.white);

  let cx = 0;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 3, y + 8, { width: colW[i] - 6, align: 'center', lineBreak: false });
    if (i < headers.length - 1) {
      doc.save();
      doc.lineWidth(0.3).strokeColor('#4a9a9b');
      const sepX = cx + colW[i];
      doc.moveTo(sepX, y + 4).lineTo(sepX, y + thH - 4).stroke();
      doc.restore();
    }
    cx += colW[i];
  }

  return y + thH;
}

/** % de variação, null se não tiver anterior */
function pctChange(current: number, prev: number): number | null {
  if (!prev || prev === 0) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

/** Card de insight com valor e % vs anterior */
function drawInsightCard(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  label: string, value: string, change: number | null, isExpense: boolean,
): void {
  doc.rect(x, y, w, h).fill('#f4f8f8');
  doc.save().lineWidth(0.5).strokeColor(C.grayBorder).rect(x, y, w, h).stroke().restore();

  doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
  doc.text(label.toUpperCase(), x + 8, y + 10, { width: w - 16, align: 'center' });

  doc.fontSize(13).font('Helvetica-Bold').fillColor(C.black);
  doc.text(value, x + 8, y + 26, { width: w - 16, align: 'center' });

  if (change !== null) {
    const positive = change >= 0;
    const good = isExpense ? !positive : positive;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(good ? C.green : C.red);
    doc.text(`${positive ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}% vs mês anterior`,
      x + 8, y + 48, { width: w - 16, align: 'center' });
  }
}

/** Gráfico de donut usando SVG path */
function drawDonutChart(
  doc: PDFKit.PDFDocument,
  slices: Array<{ label: string; value: number; color: string }>,
  cx: number, cy: number, r: number,
): void {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) return;

  const ri = r * 0.45;
  let angle = -Math.PI / 2;

  for (const sl of slices) {
    if (sl.value === 0) continue;
    const sweep = (sl.value / total) * Math.PI * 2;
    const end = angle + sweep;

    const x1 = cx + r  * Math.cos(angle), y1 = cy + r  * Math.sin(angle);
    const x2 = cx + r  * Math.cos(end),   y2 = cy + r  * Math.sin(end);
    const x3 = cx + ri * Math.cos(end),   y3 = cy + ri * Math.sin(end);
    const x4 = cx + ri * Math.cos(angle), y4 = cy + ri * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;

    const d = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${ri} ${ri} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      'Z',
    ].join(' ');

    doc.path(d).fill(sl.color);

    doc.save().lineWidth(1.5).strokeColor(C.white);
    doc.moveTo(cx, cy).lineTo(x1, y1).stroke();
    doc.restore();

    angle = end;
  }
}

/** Barra de título para páginas de analytics */
function drawAnalyticsTitleBar(doc: PDFKit.PDFDocument, title: string, PW: number): number {
  doc.rect(0, 0, PW, 32).fill(C.tealDark);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(C.white);
  doc.text(title, 0, 10, { width: PW, align: 'center', lineBreak: false });
  return 32;
}

/** Página de analytics — Conta Corrente */
function drawAnalyticsCC(
  doc: PDFKit.PDFDocument,
  lancamentos: LancamentoContaCorrente[],
  prevLancamentos: LancamentoContaCorrente[] | null,
  PW: number, PH: number, monthTitle: string,
): void {
  doc.addPage();

  let y = drawAnalyticsTitleBar(doc, `ANÁLISE COMPARATIVA — ${monthTitle.toUpperCase()}`, PW);

  let vendas = 0, entradas = 0, saidas = 0;
  for (const l of lancamentos) {
    if (l.tipo === 'venda')        vendas   += l.valor;
    else if (l.tipo === 'entrada') entradas += l.valor;
    else                           saidas   += l.valor;
  }
  const receita = vendas + entradas;
  const saldo   = receita - saidas;

  let pVendas = 0, pEntradas = 0, pSaidas = 0;
  if (prevLancamentos) {
    for (const l of prevLancamentos) {
      if (l.tipo === 'venda')        pVendas   += l.valor;
      else if (l.tipo === 'entrada') pEntradas += l.valor;
      else                           pSaidas   += l.valor;
    }
  }
  const pReceita = pVendas + pEntradas;
  const pSaldo   = pReceita - pSaidas;

  y += 20;

  const cards = [
    { label: 'Total Receita',  value: formatBRL(receita),  change: pctChange(receita, pReceita),   isExpense: false },
    { label: 'Total Vendas',   value: formatBRL(vendas),   change: pctChange(vendas, pVendas),     isExpense: false },
    { label: 'Total Entradas', value: formatBRL(entradas), change: pctChange(entradas, pEntradas), isExpense: false },
    { label: 'Saldo do Mês',   value: formatBRL(saldo),    change: pctChange(saldo, pSaldo),       isExpense: false },
  ];

  const cW = PW / 4, cH = 70, cPad = 8;
  for (let i = 0; i < cards.length; i++) {
    drawInsightCard(doc, i * cW + cPad, y, cW - cPad * 2, cH, cards[i].label, cards[i].value, cards[i].change, cards[i].isExpense);
  }
  y += cH + 24;

  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.grayText);
  doc.text('COMPOSIÇÃO DA RECEITA', 0, y, { width: PW, align: 'center' });
  y += 16;

  const barW = PW * 0.7, barX = (PW - barW) / 2, barH = 22;

  if (receita > 0) {
    const wPct = vendas / receita;
    doc.rect(barX, y, barW * wPct, barH).fill(C.blue);
    doc.rect(barX + barW * wPct, y, barW * (1 - wPct), barH).fill(C.green);
    if (wPct > 0.15) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
      doc.text(`VENDAS ${(wPct * 100).toFixed(0)}%`, barX + 6, y + 7, { width: barW * wPct - 10, align: 'left', lineBreak: false });
    }
    if (wPct < 0.85) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
      doc.text(`ENTRADAS ${((1 - wPct) * 100).toFixed(0)}%`, barX + barW * wPct + 6, y + 7, { width: barW * (1 - wPct) - 10, align: 'left', lineBreak: false });
    }
  } else {
    doc.rect(barX, y, barW, barH).fill(C.grayBorder);
  }
  y += barH + 8;

  const legItems = [
    { color: C.blue,  label: `Vendas — ${formatBRL(vendas)}` },
    { color: C.green, label: `Entradas bancárias — ${formatBRL(entradas)}` },
    { color: C.red,   label: `Saídas — ${formatBRL(saidas)}` },
  ];
  const legX = (PW - 600) / 2;
  for (let i = 0; i < legItems.length; i++) {
    const lx = legX + i * 200;
    doc.rect(lx, y, 12, 12).fill(legItems[i].color);
    doc.fontSize(8).font('Helvetica').fillColor(C.black);
    doc.text(legItems[i].label, lx + 16, y + 2, { lineBreak: false });
  }

  doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
  doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} · Vitall Odontologia & Saúde Integrativa`, 0, PH - 18, { width: PW, align: 'center' });
}

/** Página de analytics — Contas a Pagar */
function drawAnalyticsCP(
  doc: PDFKit.PDFDocument,
  contas: ContaPagar[],
  prevContas: ContaPagar[] | null,
  PW: number, PH: number, monthTitle: string,
): void {
  doc.addPage();

  let y = drawAnalyticsTitleBar(doc, `ANÁLISE DE DESPESAS — ${monthTitle.toUpperCase()}`, PW);

  const totalAtual = contas.reduce((s, c) => s + c.valor, 0);
  const totalPrev  = prevContas ? prevContas.reduce((s, c) => s + c.valor, 0) : 0;

  const byClassif = new Map<string, number>();
  for (const c of contas) {
    const k = c.classificacao || 'Outros';
    byClassif.set(k, (byClassif.get(k) || 0) + c.valor);
  }

  const byCateg = new Map<string, number>();
  for (const c of contas) {
    const k = c.categoria || 'Outros';
    byCateg.set(k, (byCateg.get(k) || 0) + c.valor);
  }
  const topCateg = [...byCateg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const slices: Array<{ label: string; value: number; color: string }> = [];
  let colorIdx = 0;
  for (const [label, value] of byClassif) {
    slices.push({ label, value, color: PIE_PALETTE[colorIdx % PIE_PALETTE.length] });
    colorIdx++;
  }

  const LEFT_W = 380, RIGHT_W = PW - LEFT_W;
  y += 12;

  const chartAreaH = PH - y - 30;
  const CHART_R = Math.min(100, chartAreaH * 0.38);
  const cx = LEFT_W / 2;
  const cy = y + CHART_R + 8;

  drawDonutChart(doc, slices, cx, cy, CHART_R);

  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.teal);
  doc.text('TOTAL', cx - 30, cy - 14, { width: 60, align: 'center' });
  doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
  const totalStr = formatBRL(totalAtual);
  doc.text(totalStr.length > 12 ? totalStr.replace('R$ ', 'R$\n') : totalStr, cx - 35, cy - 2, { width: 70, align: 'center' });

  let legY = cy + CHART_R + 14;
  for (const sl of slices) {
    if (legY > PH - 30) break;
    const pct = totalAtual > 0 ? ((sl.value / totalAtual) * 100).toFixed(1) : '0.0';
    doc.rect(20, legY, 10, 10).fill(sl.color);
    doc.fontSize(8).font('Helvetica').fillColor(C.black);
    doc.text(`${sl.label}`, 34, legY + 1, { width: 160, lineBreak: false, ellipsis: true });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C.black);
    doc.text(`${pct}%  ${formatBRL(sl.value)}`, 200, legY + 1, { width: 160, lineBreak: false });
    legY += 16;
  }

  const RX = LEFT_W + 12, cardW = RIGHT_W - 24;
  let ry = y;

  drawInsightCard(doc, RX, ry, cardW, 72, 'Total de Despesas', formatBRL(totalAtual), pctChange(totalAtual, totalPrev), true);
  ry += 80;

  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.grayText);
  doc.text('TOP CATEGORIAS', RX, ry, { width: cardW, align: 'center' });
  ry += 14;

  const prevByCateg = new Map<string, number>();
  if (prevContas) {
    for (const c of prevContas) {
      const k = c.categoria || 'Outros';
      prevByCateg.set(k, (prevByCateg.get(k) || 0) + c.valor);
    }
  }

  for (let i = 0; i < topCateg.length; i++) {
    const [categ, val] = topCateg[i];
    const prevVal = prevByCateg.get(categ) || 0;
    const chg = pctChange(val, prevVal);
    const rowH = 36;

    doc.rect(RX, ry, cardW, rowH).fill(i % 2 === 0 ? '#f4f8f8' : C.white);
    doc.save().lineWidth(0.4).strokeColor(C.grayBorder).rect(RX, ry, cardW, rowH).stroke().restore();

    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.teal);
    doc.text(`${i + 1}`, RX + 8, ry + 10, { width: 20 });

    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.black);
    doc.text((categ || '').toUpperCase(), RX + 28, ry + 6, { width: cardW - 110, lineBreak: false, ellipsis: true });

    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
    doc.text(formatBRL(val), RX + 28, ry + 20, { width: cardW - 110, lineBreak: false });

    if (chg !== null) {
      const good = chg < 0;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(good ? C.green : C.red);
      doc.text(`${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`, RX + cardW - 75, ry + 13, { width: 65, align: 'right' });
    }

    ry += rowH + 3;
  }

  doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
  doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} · Vitall Odontologia & Saúde Integrativa`, 0, PH - 18, { width: PW, align: 'center' });
}

/** Badge de status */
function drawBadge(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  colWidth: number,
  bgColor: string,
  textColor: string,
): void {
  const badgeW = 50;
  const badgeH = 15;
  const badgeX = x + (colWidth - badgeW) / 2;
  doc.save();
  doc.roundedRect(badgeX, y, badgeW, badgeH, 3).fill(bgColor);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(textColor);
  doc.text(text, badgeX, y + 4, { width: badgeW, align: 'center', lineBreak: false });
  doc.restore();
}

/** Gera PDF de Conta Corrente com layout full-width */
async function generateContaCorrentePDF(yearMonth: string, lancamentos: LancamentoContaCorrente[], prevLancamentos: LancamentoContaCorrente[] | null = null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const PW = doc.page.width;
    const PH = doc.page.height;

    let y = drawPageHeader(doc, 'Extrato Conta Corrente', titleMonth, PW);

    // Colunas proporcionais: Data | Tipo | Descrição | Contraparte | Valor
    const colW = calcColWidths([10, 11, 35, 27, 17], PW);
    const headers = ['DATA', 'TIPO', 'DESCRIÇÃO', 'CONTRAPARTE', 'VALOR'];

    y = drawTableHeader(doc, headers, colW, y);

    let totalVendas = 0, totalEntradas = 0, totalSaidas = 0;
    let rowIndex = 0;
    const ROW_H = 28;
    const SUMMARY_H = 110;

    for (const lanc of lancamentos) {
      if (y + ROW_H > PH - 8) {
        doc.addPage();
        doc.rect(0, 0, PW, 4).fill(C.teal);
        y = 4;
      }

      const bg = rowIndex % 2 === 0 ? C.white : C.tealLight;
      doc.rect(0, y, PW, ROW_H).fill(bg);
      doc.lineWidth(0.3).strokeColor(C.grayBorder);
      doc.moveTo(0, y + ROW_H).lineTo(PW, y + ROW_H).stroke();

      let cx = 0;

      // Data + Dia da semana
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatDate(lanc.data), cx + 3, y + 5, { width: colW[0] - 6, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
      doc.text(getDayOfWeek(lanc.data), cx + 3, y + 17, { width: colW[0] - 6, align: 'center', lineBreak: false });
      cx += colW[0];

      // Tipo — badge colorido
      const tipoCfg = lanc.tipo === 'entrada'
        ? { bg: C.greenLight, vc: C.green, label: 'ENTRADA' }
        : lanc.tipo === 'venda'
        ? { bg: C.blueLight,  vc: C.blue,  label: 'VENDA'   }
        : { bg: C.redLight,   vc: C.red,   label: 'SAÍDA'   };
      drawBadge(doc, tipoCfg.label, cx, y + 7, colW[1], tipoCfg.bg, tipoCfg.vc);
      cx += colW[1];

      // Descrição — centralizada, CAPS LOCK
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text((lanc.descricao || '').toUpperCase(), cx + 3, y + 10, { width: colW[2] - 6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[2];

      // Contraparte — centralizada, CAPS LOCK
      doc.fontSize(8.5).font('Helvetica').fillColor(C.grayText);
      doc.text((lanc.contraparte || '').toUpperCase(), cx + 3, y + 10, { width: colW[3] - 6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[3];

      // Valor — azul para venda, verde para entrada, vermelho para saída
      const valorColor = lanc.tipo === 'saida' ? C.red : lanc.tipo === 'venda' ? C.blue : C.green;
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(valorColor);
      doc.text(formatBRL(lanc.valor), cx + 3, y + 10, { width: colW[4] - 6, align: 'center', lineBreak: false });

      if (lanc.tipo === 'venda') totalVendas += lanc.valor;
      else if (lanc.tipo === 'entrada') totalEntradas += lanc.valor;
      else totalSaidas += lanc.valor;

      y += ROW_H;
      rowIndex++;
    }

    // Resumo final
    if (y + SUMMARY_H > PH) {
      doc.addPage();
      doc.rect(0, 0, PW, 4).fill(C.teal);
      y = 12;
    } else {
      y += 12;
    }

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO DO PERÍODO', 0, y, { width: PW, align: 'center' });
    y += 18;

    const saldo = totalVendas + totalEntradas - totalSaidas;
    const boxItems = [
      { label: 'Total Vendas',   value: formatBRL(totalVendas),   bg: C.blueLight,  vc: C.blue,  lc: C.grayText },
      { label: 'Total Entradas', value: formatBRL(totalEntradas), bg: C.greenLight, vc: C.green, lc: C.grayText },
      { label: 'Total Saídas',   value: formatBRL(totalSaidas),   bg: C.redLight,   vc: C.red,   lc: C.grayText },
      { label: 'SALDO DO MÊS',   value: formatBRL(saldo),         bg: C.teal,       vc: C.white, lc: '#a8d4d5'  },
    ];

    const boxW = PW / 4;
    const boxH = 50;
    const pad = 6;

    for (let i = 0; i < boxItems.length; i++) {
      const bx = i * boxW;
      const item = boxItems[i];
      doc.rect(bx + pad, y, boxW - pad * 2, boxH).fill(item.bg);
      doc.fontSize(8).font('Helvetica').fillColor(item.lc);
      doc.text(item.label, bx + pad, y + 9, { width: boxW - pad * 2, align: 'center' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(item.vc);
      doc.text(item.value, bx + pad, y + 25, { width: boxW - pad * 2, align: 'center' });
    }

    y += boxH + 12;

    const geradoEm = new Date().toLocaleDateString('pt-BR');
    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Gerado em ${geradoEm} · Vitall Odontologia & Saúde Integrativa`, 0, y, { width: PW, align: 'center' });

    // Página de analytics
    drawAnalyticsCC(doc, lancamentos, prevLancamentos, PW, PH, titleMonth);

    doc.end();
  });
}


/** Gera PDF de Contas a Pagar com layout full-width */
async function generateContasPagarPDF(yearMonth: string, contas: ContaPagar[], prevContas: ContaPagar[] | null = null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const PW = doc.page.width;
    const PH = doc.page.height;

    let y = drawPageHeader(doc, 'Contas a Pagar', titleMonth, PW);

    // Colunas proporcionais: Venc | Descrição | Categoria | Classificação | Valor | Status
    const colW = calcColWidths([10, 29, 15, 16, 16, 14], PW);
    const headers = ['VENCIMENTO', 'DESCRIÇÃO', 'CATEGORIA', 'CLASSIFICAÇÃO', 'VALOR', 'STATUS'];

    y = drawTableHeader(doc, headers, colW, y);

    const resumo = new Map<string, number>();
    let totalAberto = 0, totalPago = 0;
    let rowIndex = 0;
    const ROW_H = 28;
    const SUMMARY_H = 200;

    for (const conta of contas) {
      if (y + ROW_H > PH - 8) {
        doc.addPage();
        doc.rect(0, 0, PW, 4).fill(C.teal);
        y = 4;
      }

      const bg = rowIndex % 2 === 0 ? C.white : C.tealLight;
      doc.rect(0, y, PW, ROW_H).fill(bg);
      doc.lineWidth(0.3).strokeColor(C.grayBorder);
      doc.moveTo(0, y + ROW_H).lineTo(PW, y + ROW_H).stroke();

      let cx = 0;

      // Vencimento + Dia da semana
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatDate(conta.vencimento), cx + 3, y + 5, { width: colW[0] - 6, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
      doc.text(getDayOfWeek(conta.vencimento), cx + 3, y + 17, { width: colW[0] - 6, align: 'center', lineBreak: false });
      cx += colW[0];

      // Descrição — centralizada, CAPS LOCK
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text((conta.descricao || '').toUpperCase(), cx + 3, y + 10, { width: colW[1] - 6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[1];

      // Categoria — centralizada, CAPS LOCK
      doc.fontSize(8.5).font('Helvetica').fillColor(C.grayText);
      doc.text((conta.categoria || '').toUpperCase(), cx + 3, y + 10, { width: colW[2] - 6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[2];

      // Classificação — centralizada, CAPS LOCK
      doc.fontSize(8.5).font('Helvetica').fillColor(C.black);
      doc.text((conta.classificacao || '').toUpperCase(), cx + 3, y + 10, { width: colW[3] - 6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[3];

      // Valor — centralizado
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatBRL(conta.valor), cx + 3, y + 10, { width: colW[4] - 6, align: 'center', lineBreak: false });
      cx += colW[4];

      // Status badge
      const isPago = conta.status === 'realizado';
      drawBadge(doc, isPago ? 'PAGO' : 'ABERTO', cx, y + 6, colW[5], isPago ? C.greenLight : C.redLight, isPago ? C.green : C.red);

      const classif = conta.classificacao || 'Outros';
      resumo.set(classif, (resumo.get(classif) || 0) + conta.valor);
      if (isPago) totalPago += conta.valor; else totalAberto += conta.valor;

      y += ROW_H;
      rowIndex++;
    }

    // Resumo final
    if (y + SUMMARY_H > PH) {
      doc.addPage();
      doc.rect(0, 0, PW, 4).fill(C.teal);
      y = 14;
    } else {
      y += 14;
    }

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO POR CLASSIFICAÇÃO', 0, y, { width: PW, align: 'center' });
    y += 18;

    const rW = Math.min(500, PW * 0.60);
    const rX = (PW - rW) / 2;
    const rRowH = 20;

    let ri = 0;
    for (const [classif, total] of resumo) {
      const bg = ri % 2 === 0 ? C.tealLight : C.white;
      doc.rect(rX, y, rW, rRowH).fill(bg);
      doc.lineWidth(0.3).strokeColor(C.grayBorder);
      doc.moveTo(rX, y + rRowH).lineTo(rX + rW, y + rRowH).stroke();
      doc.fontSize(8.5).font('Helvetica').fillColor(C.black);
      doc.text(classif, rX + 10, y + 6, { width: rW * 0.55 });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatBRL(total), rX + rW * 0.55, y + 6, { width: rW * 0.42, align: 'right' });
      y += rRowH;
      ri++;
    }

    y += 14;

    const totItems = [
      { label: 'Total Pago',   value: formatBRL(totalPago),               bg: C.greenLight, vc: C.green, lc: C.grayText },
      { label: 'Total Aberto', value: formatBRL(totalAberto),             bg: C.redLight,   vc: C.red,   lc: C.grayText },
      { label: 'TOTAL GERAL',  value: formatBRL(totalAberto + totalPago), bg: C.teal,       vc: C.white, lc: '#a8d4d5'  },
    ];
    const tbW = PW / 3;
    const tbH = 50;
    const tbPad = 8;

    for (let i = 0; i < totItems.length; i++) {
      const bx = i * tbW;
      const item = totItems[i];
      doc.rect(bx + tbPad, y, tbW - tbPad * 2, tbH).fill(item.bg);
      doc.fontSize(8).font('Helvetica').fillColor(item.lc);
      doc.text(item.label, bx + tbPad, y + 9, { width: tbW - tbPad * 2, align: 'center' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(item.vc);
      doc.text(item.value, bx + tbPad, y + 25, { width: tbW - tbPad * 2, align: 'center' });
    }

    y += tbH + 12;

    const geradoEm = new Date().toLocaleDateString('pt-BR');
    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Gerado em ${geradoEm} · Vitall Odontologia & Saúde Integrativa`, 0, y, { width: PW, align: 'center' });

    // Página de analytics
    drawAnalyticsCP(doc, contas, prevContas, PW, PH, titleMonth);

    doc.end();
  });
}


// ── Orchestration ──

/**
 * Executa o fluxo completo de geração de relatório financeiro mensal.
 * Chamado pelo cron todo dia 01 às 06:00 UTC (03:00 BRT).
 */
export async function executeMonthlyReport(): Promise<void> {
  try {
    console.log('[FinReport] Iniciando geração de relatório financeiro mensal...');

    // 1. Calcular mês anterior
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yearMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
    const monthName = lastMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const monthTitle = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    console.log(`[FinReport] Mês: ${yearMonth} (${monthTitle})`);

    // 2. Fetch dados (mês atual + mês anterior para comparação)
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const prevYearMonth = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

    const [lancamentos, contas, prevLancamentos, prevContas] = await Promise.all([
      fetchContaCorrente(yearMonth),
      fetchContasPagar(yearMonth),
      fetchContaCorrente(prevYearMonth),
      fetchContasPagar(prevYearMonth),
    ]);

    if (lancamentos.length === 0 && contas.length === 0) {
      console.log('[FinReport] Nenhum dado financeiro encontrado para o mês. Abortando.');
      await sendText(env.JESSICA_PHONE, `⚠️ *Relatório Financeiro Mensal*\n\nNenhum dado encontrado para ${monthTitle}. Verifique o banco de dados.`);
      return;
    }

    // 3. Gerar PDFs
    console.log('[FinReport] Gerando PDFs...');
    const [contaCorrentePDF, contasPagarPDF] = await Promise.all([
      generateContaCorrentePDF(yearMonth, lancamentos, prevLancamentos),
      generateContasPagarPDF(yearMonth, contas, prevContas),
    ]);

    console.log(`[FinReport] PDFs gerados: Conta Corrente (${(contaCorrentePDF.length / 1024).toFixed(1)} KB), Contas a Pagar (${(contasPagarPDF.length / 1024).toFixed(1)} KB)`);

    // 4. Upload no Drive
    if (!drive.isAvailable()) {
      console.warn('[FinReport] Google Drive não configurado. PDFs NÃO foram enviados.');
      await sendText(env.JESSICA_PHONE, `⚠️ *Relatório Financeiro Mensal*\n\nPDFs gerados mas Google Drive não está configurado. Configure GOOGLE_DRIVE_CLINIC_REFRESH_TOKEN e GOOGLE_DRIVE_FOLDER_ID.`);
      return;
    }

    console.log('[FinReport] Fazendo upload no Google Drive...');
    const folderId = await drive.ensureMonthFolder(yearMonth, env.GOOGLE_DRIVE_FOLDER_ID);

    const [contaCorrenteLink, contasPagarLink] = await Promise.all([
      drive.uploadPDF(`Conta Corrente - ${monthTitle}.pdf`, contaCorrentePDF, folderId),
      drive.uploadPDF(`Contas a Pagar - ${monthTitle}.pdf`, contasPagarPDF, folderId),
    ]);

    const folderLink = `https://drive.google.com/drive/folders/${folderId}`;
    console.log(`[FinReport] PDFs enviados para: ${folderLink}`);

    // 5. Enviar email para contabilidade (com PDFs anexados + botões Drive)
    const emailSent = await gmail.sendEmail(
      env.ACCOUNTANT_EMAIL,
      `Relatórios Financeiros - ${monthTitle} - Vitall Odontologia`,
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

    <div style="background:linear-gradient(135deg,#277d7e 0%,#1f6364 100%);padding:40px 30px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:600;">Relatórios Financeiros</h1>
      <p style="margin:10px 0 0;color:rgba(255,255,255,0.9);font-size:17px;">${monthTitle}</p>
    </div>

    <div style="padding:36px 30px;">
      <p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.6;">Excelente dia,</p>
      <p style="margin:0 0 28px;color:#555;font-size:14px;line-height:1.6;">
        Seguem os relatórios financeiros da <strong style="color:#277d7e;">Vitall Odontologia</strong> referentes ao mês de <strong>${monthTitle}</strong>. Os PDFs estão anexados e também disponíveis no Google Drive:
      </p>

      <div style="background:#f9fafb;border-radius:8px;padding:22px;margin-bottom:24px;">
        <div style="margin-bottom:12px;">
          <a href="${contaCorrenteLink.webViewLink}" style="display:block;padding:14px 20px;background:#277d7e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;text-align:center;">
            📊 Conta Corrente — ${monthTitle}
          </a>
        </div>
        <div>
          <a href="${contasPagarLink.webViewLink}" style="display:block;padding:14px 20px;background:#277d7e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;text-align:center;">
            📋 Contas a Pagar — ${monthTitle}
          </a>
        </div>
      </div>

      <div style="text-align:center;padding:18px;background:#f0fffe;border:2px dashed #277d7e;border-radius:8px;">
        <p style="margin:0 0 10px;color:#555;font-size:13px;">Acesse todos os arquivos na pasta do Google Drive:</p>
        <a href="${folderLink}" style="display:inline-block;padding:10px 24px;background:#ffffff;color:#277d7e;text-decoration:none;border:2px solid #277d7e;border-radius:6px;font-weight:600;font-size:14px;">
          📁 Abrir Pasta no Drive
        </a>
      </div>
    </div>

    <div style="background:#f9fafb;padding:24px 30px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0 0 6px;color:#277d7e;font-weight:600;font-size:15px;">Vitall Odontologia & Saúde Integrativa</p>
      <p style="margin:0;color:#aaa;font-size:12px;">Email gerado automaticamente pelo VitallAssistente</p>
    </div>

  </div>
</body>
</html>`,
      [
        { filename: `Conta Corrente - ${monthTitle}.pdf`, content: contaCorrentePDF, contentType: 'application/pdf' },
        { filename: `Contas a Pagar - ${monthTitle}.pdf`, content: contasPagarPDF,   contentType: 'application/pdf' },
      ],
    );

    if (emailSent) {
      console.log(`[FinReport] Email enviado para ${env.ACCOUNTANT_EMAIL}`);
    } else {
      console.warn('[FinReport] Email NÃO enviado (scope gmail.send ausente ou erro)');
    }

    // 6. Enviar WhatsApp de confirmação
    const whatsappMsg = `✅ *Relatório Financeiro Mensal*\n\n*Mês:* ${monthTitle}\n\n📊 PDFs gerados e enviados para o Google Drive:\n• Conta Corrente\n• Contas a Pagar\n\n📧 Email ${emailSent ? 'enviado' : 'NÃO enviado (configure gmail.send scope)'} para: ${env.ACCOUNTANT_EMAIL}\n\n🔗 Link da pasta:\n${folderLink}`;
    await sendText(env.JESSICA_PHONE, whatsappMsg);

    console.log('[FinReport] Relatório financeiro mensal concluído com sucesso!');
  } catch (error: any) {
    console.error('[FinReport] Erro ao gerar relatório financeiro mensal:', error.message);
    await sendText(env.JESSICA_PHONE, `❌ *Erro no Relatório Financeiro Mensal*\n\n${error.message}`);
  }
}
