/**
 * Script de preview dos PDFs financeiros — dados REAIS do Supabase.
 * Rode: node test-pdf-preview.js
 */

require('dotenv').config();
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Cores Vitall ──
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

// Paleta para gráfico de pizza (cicla se tiver muitas fatias)
const PIE_PALETTE = ['#277d7e','#2563eb','#c89d68','#059669','#7c3aed','#0891b2','#f59e0b','#db2777'];

const LOGO_PATH = path.join(__dirname, 'assets/vitall-logo.png');

// ── Helpers ──

function formatBRL(v) {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return ['DOM','SEG','TER','QUA','QUI','SEX','SAB'][new Date(+y, +m-1, +d).getDay()];
}
function calcColWidths(pcts, pw) {
  const total = pcts.reduce((a, b) => a + b, 0);
  const cols = pcts.map(p => Math.floor((p / total) * pw));
  cols[cols.length - 1] += pw - cols.reduce((a, b) => a + b, 0);
  return cols;
}
/** % change, null se não tiver anterior */
function pctChange(current, prev) {
  if (!prev || prev === 0) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

// ── Componentes visuais ──

/** Header da página: barra teal + fundo branco + logo + título CENTRALIZADO */
function drawPageHeader(doc, title, monthTitle, PW) {
  const ACCENT = 5, BODY = 62, TOTAL = ACCENT + BODY;
  doc.rect(0, 0, PW, ACCENT).fill(C.teal);
  doc.rect(0, ACCENT, PW, BODY).fill(C.white);

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 14, ACCENT + (BODY - 42) / 2, { fit: [100, 42] });
  }

  const titleY = ACCENT + BODY / 2 - 18;
  // Centraliza em relação à página INTEIRA
  doc.fontSize(15).font('Helvetica-Bold').fillColor(C.teal);
  doc.text(title.toUpperCase(), 0, titleY, { width: PW, align: 'center', lineBreak: false });
  doc.fontSize(10).font('Helvetica').fillColor(C.grayText);
  doc.text(`Competência: ${monthTitle}`, 0, titleY + 22, { width: PW, align: 'center', lineBreak: false });

  doc.rect(0, TOTAL - 1, PW, 2).fill(C.teal);
  return TOTAL + 1;
}

/** Cabeçalho de colunas */
function drawTableHeader(doc, headers, colW, y) {
  const thH = 26;
  doc.rect(0, y, colW.reduce((a,b)=>a+b,0), thH).fill(C.tealDark);
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.white);
  let cx = 0;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 3, y + 8, { width: colW[i] - 6, align: 'center', lineBreak: false });
    if (i < headers.length - 1) {
      doc.save().lineWidth(0.3).strokeColor('#4a9a9b');
      doc.moveTo(cx + colW[i], y + 4).lineTo(cx + colW[i], y + thH - 4).stroke();
      doc.restore();
    }
    cx += colW[i];
  }
  return y + thH;
}

/** Badge colorido (pill) */
function drawBadge(doc, text, x, y, colW, bg, fg) {
  const bW = 50, bH = 15, bX = x + (colW - bW) / 2;
  doc.save().roundedRect(bX, y, bW, bH, 3).fill(bg);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(fg);
  doc.text(text, bX, y + 4, { width: bW, align: 'center', lineBreak: false });
  doc.restore();
}

/** Card de insight com valor e % vs anterior */
function drawInsightCard(doc, x, y, w, h, label, value, change, isExpense) {
  doc.rect(x, y, w, h).fill('#f4f8f8');
  doc.save().lineWidth(0.5).strokeColor(C.grayBorder).rect(x, y, w, h).stroke().restore();

  doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
  doc.text(label.toUpperCase(), x + 8, y + 10, { width: w - 16, align: 'center' });

  doc.fontSize(13).font('Helvetica-Bold').fillColor(C.black);
  doc.text(value, x + 8, y + 26, { width: w - 16, align: 'center' });

  if (change !== null && change !== undefined) {
    const positive = change >= 0;
    const good = isExpense ? !positive : positive;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(good ? C.green : C.red);
    doc.text(`${positive ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}% vs mês anterior`,
      x + 8, y + 48, { width: w - 16, align: 'center' });
  }
}

/**
 * Gráfico de donut (pizza com buraco).
 * slices: [{ label, value, color }]
 */
function drawDonutChart(doc, slices, cx, cy, r) {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) return;

  const ri = r * 0.45; // raio interno
  let angle = -Math.PI / 2; // começa do topo

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

    // Separador branco entre fatias
    doc.save().lineWidth(1.5).strokeColor(C.white);
    doc.moveTo(cx, cy).lineTo(x1, y1).stroke();
    doc.restore();

    angle = end;
  }
}

/** Barra de seção de analytics */
function drawAnalyticsTitleBar(doc, title, PW) {
  doc.rect(0, 0, PW, 32).fill(C.tealDark);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(C.white);
  doc.text(title, 0, 10, { width: PW, align: 'center', lineBreak: false });
  return 32;
}

// ── Página de analytics — Conta Corrente ──

function drawAnalyticsCC(doc, lancamentos, prevLancamentos, PW, PH, monthTitle) {
  doc.addPage();

  const titleMonth = monthTitle.toUpperCase();
  let y = drawAnalyticsTitleBar(doc, `ANÁLISE COMPARATIVA — ${titleMonth}`, PW);

  // Calcular totais atuais
  let vendas = 0, entradas = 0, saidas = 0;
  for (const l of lancamentos) {
    if (l.tipo === 'venda')   vendas   += l.valor;
    else if (l.tipo === 'entrada') entradas += l.valor;
    else                      saidas   += l.valor;
  }
  const receita = vendas + entradas;
  const saldo   = receita - saidas;

  // Calcular totais do mês anterior
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

  // 4 cards lado a lado
  const cards = [
    { label: 'Total Receita',  value: formatBRL(receita),  change: pctChange(receita, pReceita),   isExpense: false },
    { label: 'Total Vendas',   value: formatBRL(vendas),   change: pctChange(vendas, pVendas),     isExpense: false },
    { label: 'Total Entradas', value: formatBRL(entradas), change: pctChange(entradas, pEntradas), isExpense: false },
    { label: 'Saldo do Mês',   value: formatBRL(saldo),    change: pctChange(saldo, pSaldo),       isExpense: false },
  ];

  const cW = PW / 4;
  const cH = 70;
  const cPad = 8;
  for (let i = 0; i < cards.length; i++) {
    drawInsightCard(doc, i * cW + cPad, y, cW - cPad * 2, cH, cards[i].label, cards[i].value, cards[i].change, cards[i].isExpense);
  }
  y += cH + 24;

  // Barra de proporção vendas vs entradas
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.grayText);
  doc.text('COMPOSIÇÃO DA RECEITA', 0, y, { width: PW, align: 'center' });
  y += 16;

  const barW = PW * 0.7;
  const barX = (PW - barW) / 2;
  const barH = 22;

  if (receita > 0) {
    const wPct = vendas / receita;
    doc.rect(barX, y, barW * wPct, barH).fill(C.blue);
    doc.rect(barX + barW * wPct, y, barW * (1 - wPct), barH).fill(C.green);

    // Labels dentro da barra
    if (wPct > 0.15) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
      doc.text(`VENDAS ${(wPct*100).toFixed(0)}%`, barX + 6, y + 7, { width: barW * wPct - 10, align: 'left', lineBreak: false });
    }
    if (wPct < 0.85) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
      doc.text(`ENTRADAS ${((1-wPct)*100).toFixed(0)}%`, barX + barW * wPct + 6, y + 7, { width: barW * (1-wPct) - 10, align: 'left', lineBreak: false });
    }
  } else {
    doc.rect(barX, y, barW, barH).fill(C.grayBorder);
  }
  y += barH + 8;

  // Legenda da barra
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

  // Rodapé
  const geradoEm = new Date().toLocaleDateString('pt-BR');
  doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
  doc.text(`Gerado em ${geradoEm} · Vitall Odontologia & Saúde Integrativa`, 0, PH - 18, { width: PW, align: 'center' });
}

// ── Página de analytics — Contas a Pagar ──

function drawAnalyticsCP(doc, contas, prevContas, PW, PH, monthTitle) {
  doc.addPage();

  const titleMonth = monthTitle.toUpperCase();
  let y = drawAnalyticsTitleBar(doc, `ANÁLISE DE DESPESAS — ${titleMonth}`, PW);

  // Totais atuais
  const totalAtual = contas.reduce((s, c) => s + c.valor, 0);
  const totalPrev  = prevContas ? prevContas.reduce((s, c) => s + c.valor, 0) : 0;

  // Agrupar por classificação
  const byClassif = new Map();
  for (const c of contas) {
    const k = c.classificacao || 'Outros';
    byClassif.set(k, (byClassif.get(k) || 0) + c.valor);
  }

  // Agrupar por categoria (top 5)
  const byCateg = new Map();
  for (const c of contas) {
    const k = c.categoria || 'Outros';
    byCateg.set(k, (byCateg.get(k) || 0) + c.valor);
  }
  const topCateg = [...byCateg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Preparar fatias do donut
  const slices = [];
  let colorIdx = 0;
  for (const [label, value] of byClassif) {
    slices.push({ label, value, color: PIE_PALETTE[colorIdx % PIE_PALETTE.length] });
    colorIdx++;
  }

  // ── Layout: esquerda = donut + legenda | direita = cards ──
  const LEFT_W = 380;
  const RIGHT_W = PW - LEFT_W;

  y += 12;

  // --- Lado esquerdo: donut chart ---
  const chartAreaH = PH - y - 30;
  const CHART_R = Math.min(100, chartAreaH * 0.38);
  const cx = LEFT_W / 2;
  const cy = y + CHART_R + 8;

  drawDonutChart(doc, slices, cx, cy, CHART_R);

  // Valor total no centro do donut
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.teal);
  doc.text('TOTAL', cx - 30, cy - 14, { width: 60, align: 'center' });
  doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
  // Split into two lines if needed
  const totalStr = formatBRL(totalAtual);
  doc.text(totalStr.length > 12 ? totalStr.replace('R$ ', 'R$\n') : totalStr,
    cx - 35, cy - 2, { width: 70, align: 'center' });

  // Legenda abaixo do donut
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

  // --- Lado direito: cards ---
  const RX = LEFT_W + 12;
  const cardW = RIGHT_W - 24;
  let ry = y;

  // Card 1: Total geral + % vs anterior
  drawInsightCard(doc, RX, ry, cardW, 72, 'Total de Despesas', formatBRL(totalAtual), pctChange(totalAtual, totalPrev), true);
  ry += 80;

  // Top categorias
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.grayText);
  doc.text('TOP CATEGORIAS', RX, ry, { width: cardW, align: 'center' });
  ry += 14;

  const prevByCateg = new Map();
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

    // Rank number
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.teal);
    doc.text(`${i+1}`, RX + 8, ry + 10, { width: 20 });

    // Categoria name
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.black);
    doc.text((categ || '').toUpperCase(), RX + 28, ry + 6, { width: cardW - 110, lineBreak: false, ellipsis: true });

    // Value
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
    doc.text(formatBRL(val), RX + 28, ry + 20, { width: cardW - 110, lineBreak: false });

    // % change
    if (chg !== null) {
      const good = chg < 0; // despesa caiu = bom
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(good ? C.green : C.red);
      doc.text(`${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`, RX + cardW - 75, ry + 13, { width: 65, align: 'right' });
    }

    ry += rowH + 3;
  }

  // Rodapé
  const geradoEm = new Date().toLocaleDateString('pt-BR');
  doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
  doc.text(`Gerado em ${geradoEm} · Vitall Odontologia & Saúde Integrativa`, 0, PH - 18, { width: PW, align: 'center' });
}

// ── Geração do PDF: Conta Corrente ──

function generateContaCorrentePDF(yearMonth, lancamentos, prevLancamentos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(+year, +month - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const PW = doc.page.width, PH = doc.page.height;

    let y = drawPageHeader(doc, 'Extrato Conta Corrente', titleMonth, PW);

    // Colunas: Data | Tipo | Descrição | Contraparte | Valor
    const colW = calcColWidths([10, 11, 35, 27, 17], PW);
    y = drawTableHeader(doc, ['DATA','TIPO','DESCRIÇÃO','CONTRAPARTE','VALOR'], colW, y);

    let totalVendas = 0, totalEntradas = 0, totalSaidas = 0;
    let rowIdx = 0;
    const ROW_H = 28, SUMMARY_H = 110;

    for (const lanc of lancamentos) {
      if (y + ROW_H > PH - 8) {
        doc.addPage();
        doc.rect(0, 0, PW, 4).fill(C.teal);
        y = 4;
      }

      doc.rect(0, y, PW, ROW_H).fill(rowIdx % 2 === 0 ? C.white : C.tealLight);
      doc.lineWidth(0.3).strokeColor(C.grayBorder).moveTo(0, y + ROW_H).lineTo(PW, y + ROW_H).stroke();

      let cx = 0;

      // Data + dia da semana
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatDate(lanc.data), cx+3, y+5, { width: colW[0]-6, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
      doc.text(getDayOfWeek(lanc.data), cx+3, y+17, { width: colW[0]-6, align: 'center', lineBreak: false });
      cx += colW[0];

      // Tipo — badge
      const tipoCfg = lanc.tipo === 'entrada'
        ? { bg: C.greenLight, vc: C.green, label: 'ENTRADA' }
        : lanc.tipo === 'venda'
        ? { bg: C.blueLight,  vc: C.blue,  label: 'VENDA'   }
        : { bg: C.redLight,   vc: C.red,   label: 'SAÍDA'   };
      drawBadge(doc, tipoCfg.label, cx, y+7, colW[1], tipoCfg.bg, tipoCfg.vc);
      cx += colW[1];

      // Descrição — CAPS LOCK, centralizado
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text((lanc.descricao||'').toUpperCase(), cx+3, y+10, { width: colW[2]-6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[2];

      // Contraparte — CAPS LOCK, centralizado
      doc.fontSize(8.5).font('Helvetica').fillColor(C.grayText);
      doc.text((lanc.contraparte||'').toUpperCase(), cx+3, y+10, { width: colW[3]-6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[3];

      // Valor — azul para venda, verde para entrada, vermelho para saída
      const valorColor = lanc.tipo === 'saida' ? C.red : lanc.tipo === 'venda' ? C.blue : C.green;
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(valorColor);
      doc.text(formatBRL(lanc.valor), cx+3, y+10, { width: colW[4]-6, align: 'center', lineBreak: false });

      if (lanc.tipo === 'venda')   totalVendas   += lanc.valor;
      else if (lanc.tipo === 'entrada') totalEntradas += lanc.valor;
      else                         totalSaidas   += lanc.valor;

      y += ROW_H;
      rowIdx++;
    }

    // ── Resumo ──
    if (y + SUMMARY_H > PH) { doc.addPage(); doc.rect(0,0,PW,4).fill(C.teal); y = 12; }
    else y += 12;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO DO PERÍODO', 0, y, { width: PW, align: 'center' });
    y += 18;

    const saldo = totalVendas + totalEntradas - totalSaidas;
    const boxes = [
      { label: 'Total Vendas',   value: formatBRL(totalVendas),   bg: C.blueLight,  vc: C.blue,  lc: C.grayText },
      { label: 'Total Entradas', value: formatBRL(totalEntradas), bg: C.greenLight, vc: C.green, lc: C.grayText },
      { label: 'Total Saídas',   value: formatBRL(totalSaidas),   bg: C.redLight,   vc: C.red,   lc: C.grayText },
      { label: 'SALDO DO MÊS',   value: formatBRL(saldo),         bg: C.teal,       vc: C.white, lc: '#a8d4d5'  },
    ];
    const bW = PW / 4, bH = 50, bP = 6;
    for (let i = 0; i < boxes.length; i++) {
      const bx = i * bW, item = boxes[i];
      doc.rect(bx+bP, y, bW-bP*2, bH).fill(item.bg);
      doc.fontSize(8).font('Helvetica').fillColor(item.lc);
      doc.text(item.label, bx+bP, y+9, { width: bW-bP*2, align: 'center' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(item.vc);
      doc.text(item.value, bx+bP, y+25, { width: bW-bP*2, align: 'center' });
    }
    y += bH + 12;

    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} · Vitall Odontologia & Saúde Integrativa`, 0, y, { width: PW, align: 'center' });

    // ── Página de analytics ──
    drawAnalyticsCC(doc, lancamentos, prevLancamentos, PW, PH, titleMonth);

    doc.end();
  });
}

// ── Geração do PDF: Contas a Pagar ──

function generateContasPagarPDF(yearMonth, contas, prevContas) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(+year, +month - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const PW = doc.page.width, PH = doc.page.height;

    let y = drawPageHeader(doc, 'Contas a Pagar', titleMonth, PW);

    // Colunas: Venc | Descrição | Categoria | Classificação | Valor | Status
    const colW = calcColWidths([10, 29, 15, 16, 16, 14], PW);
    y = drawTableHeader(doc, ['VENCIMENTO','DESCRIÇÃO','CATEGORIA','CLASSIFICAÇÃO','VALOR','STATUS'], colW, y);

    const resumo = new Map();
    let totalAberto = 0, totalPago = 0, rowIdx = 0;
    const ROW_H = 28, SUMMARY_H = 200;

    for (const conta of contas) {
      if (y + ROW_H > PH - 8) {
        doc.addPage();
        doc.rect(0, 0, PW, 4).fill(C.teal);
        y = 4;
      }

      doc.rect(0, y, PW, ROW_H).fill(rowIdx % 2 === 0 ? C.white : C.tealLight);
      doc.lineWidth(0.3).strokeColor(C.grayBorder).moveTo(0, y+ROW_H).lineTo(PW, y+ROW_H).stroke();

      let cx = 0;

      // Vencimento + dia
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatDate(conta.vencimento), cx+3, y+5, { width: colW[0]-6, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
      doc.text(getDayOfWeek(conta.vencimento), cx+3, y+17, { width: colW[0]-6, align: 'center', lineBreak: false });
      cx += colW[0];

      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text((conta.descricao||'').toUpperCase(), cx+3, y+10, { width: colW[1]-6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[1];

      doc.fontSize(8.5).font('Helvetica').fillColor(C.grayText);
      doc.text((conta.categoria||'').toUpperCase(), cx+3, y+10, { width: colW[2]-6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[2];

      doc.fontSize(8.5).font('Helvetica').fillColor(C.black);
      doc.text((conta.classificacao||'').toUpperCase(), cx+3, y+10, { width: colW[3]-6, align: 'center', lineBreak: false, ellipsis: true });
      cx += colW[3];

      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.black);
      doc.text(formatBRL(conta.valor), cx+3, y+10, { width: colW[4]-6, align: 'center', lineBreak: false });
      cx += colW[4];

      const isPago = conta.status === 'realizado';
      drawBadge(doc, isPago ? 'PAGO' : 'ABERTO', cx, y+6, colW[5], isPago ? C.greenLight : C.redLight, isPago ? C.green : C.red);

      const classif = conta.classificacao || 'Outros';
      resumo.set(classif, (resumo.get(classif) || 0) + conta.valor);
      if (isPago) totalPago += conta.valor; else totalAberto += conta.valor;

      y += ROW_H;
      rowIdx++;
    }

    // ── Resumo ──
    if (y + SUMMARY_H > PH) { doc.addPage(); doc.rect(0,0,PW,4).fill(C.teal); y = 14; }
    else y += 14;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO POR CLASSIFICAÇÃO', 0, y, { width: PW, align: 'center' });
    y += 18;

    const rW = Math.min(500, PW * 0.60), rX = (PW - rW) / 2, rH = 20;
    let ri = 0;
    for (const [classif, total] of resumo) {
      doc.rect(rX, y, rW, rH).fill(ri % 2 === 0 ? C.tealLight : C.white);
      doc.lineWidth(0.3).strokeColor(C.grayBorder).moveTo(rX, y+rH).lineTo(rX+rW, y+rH).stroke();
      doc.fontSize(8.5).font('Helvetica').fillColor(C.black).text(classif, rX+10, y+6, { width: rW*0.55 });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.black).text(formatBRL(total), rX+rW*0.55, y+6, { width: rW*0.42, align: 'right' });
      y += rH; ri++;
    }
    y += 14;

    const tItems = [
      { label: 'Total Pago',   value: formatBRL(totalPago),              bg: C.greenLight, vc: C.green, lc: C.grayText },
      { label: 'Total Aberto', value: formatBRL(totalAberto),            bg: C.redLight,   vc: C.red,   lc: C.grayText },
      { label: 'TOTAL GERAL',  value: formatBRL(totalAberto+totalPago),  bg: C.teal,       vc: C.white, lc: '#a8d4d5'  },
    ];
    const tbW = PW/3, tbH = 50, tbP = 8;
    for (let i = 0; i < tItems.length; i++) {
      const bx = i * tbW, item = tItems[i];
      doc.rect(bx+tbP, y, tbW-tbP*2, tbH).fill(item.bg);
      doc.fontSize(8).font('Helvetica').fillColor(item.lc).text(item.label, bx+tbP, y+9, { width: tbW-tbP*2, align: 'center' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(item.vc).text(item.value, bx+tbP, y+25, { width: tbW-tbP*2, align: 'center' });
    }
    y += tbH + 12;

    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} · Vitall Odontologia & Saúde Integrativa`, 0, y, { width: PW, align: 'center' });

    // ── Página de analytics ──
    drawAnalyticsCP(doc, contas, prevContas, PW, PH, titleMonth);

    doc.end();
  });
}

// ── Busca de dados ──

async function fetchContaCorrente(yearMonth) {
  const [year, month] = yearMonth.split('-');
  const s = `${yearMonth}-01`;
  const e = `${yearMonth}-${String(new Date(+year, +month, 0).getDate()).padStart(2,'0')}`;

  const { data: lancs } = await supabase.from('lancamentos_conta_corrente')
    .select('id,data,tipo,descricao,contraparte,valor').gte('data',s).lte('data',e).order('data',{ascending:true});

  const { data: contas } = await supabase.from('contas_pagar')
    .select('id,vencimento,descricao,categoria,valor').eq('status','realizado').gte('vencimento',s).lte('vencimento',e);

  const result = [...(lancs||[])];
  for (const c of (contas||[])) {
    result.push({ id:c.id, data:c.vencimento, tipo:'saida', descricao:`${c.categoria} - ${c.descricao}`, contraparte:'', valor:c.valor });
  }
  result.sort((a,b) => a.data.localeCompare(b.data));
  return result;
}

async function fetchContasPagar(yearMonth) {
  const [year, month] = yearMonth.split('-');
  const s = `${yearMonth}-01`;
  const e = `${yearMonth}-${String(new Date(+year, +month, 0).getDate()).padStart(2,'0')}`;

  const { data } = await supabase.from('contas_pagar')
    .select('id,competencia,vencimento,valor,status,classificacao,categoria,descricao')
    .gte('vencimento',s).lte('vencimento',e).order('vencimento',{ascending:true});
  return data || [];
}

function prevYearMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // mês anterior
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// ── Main ──

async function main() {
  const outDir = path.join(__dirname, 'pdf-preview');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yearMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth()+1).padStart(2,'0')}`;
  const prevMonth = prevYearMonth(yearMonth);
  const monthName = lastMonth.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
  const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  console.log(`\n🗓️  Mês atual: ${titleMonth} (${yearMonth})`);
  console.log(`🗓️  Mês anterior: ${prevMonth}\n`);

  console.log('📊 Buscando Conta Corrente...');
  const [lancamentos, prevLancs] = await Promise.all([
    fetchContaCorrente(yearMonth),
    fetchContaCorrente(prevMonth),
  ]);
  console.log(`   ✓ ${lancamentos.length} lançamentos | anterior: ${prevLancs.length}`);

  console.log('📋 Buscando Contas a Pagar...');
  const [contas, prevContas] = await Promise.all([
    fetchContasPagar(yearMonth),
    fetchContasPagar(prevMonth),
  ]);
  console.log(`   ✓ ${contas.length} contas | anterior: ${prevContas.length}\n`);

  console.log('🔄 Gerando PDFs...\n');

  const ccPDF = await generateContaCorrentePDF(yearMonth, lancamentos, prevLancs);
  const ccPath = path.join(outDir, `preview-conta-corrente-${yearMonth}.pdf`);
  fs.writeFileSync(ccPath, ccPDF);
  console.log(`✅ Conta Corrente (${(ccPDF.length/1024).toFixed(0)}KB): ${ccPath}`);

  const cpPDF = await generateContasPagarPDF(yearMonth, contas, prevContas);
  const cpPath = path.join(outDir, `preview-contas-a-pagar-${yearMonth}.pdf`);
  fs.writeFileSync(cpPath, cpPDF);
  console.log(`✅ Contas a Pagar (${(cpPDF.length/1024).toFixed(0)}KB): ${cpPath}\n`);

  console.log('✨ Abra os arquivos na pasta pdf-preview/ para revisar.');
}

main().catch(console.error);
