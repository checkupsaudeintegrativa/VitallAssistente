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
  teal: '#277d7e',        // Teal principal (header tabela + linhas alternadas)
  tealLight: '#d0e8e8',   // Teal claro (linhas alternadas)
  gold: '#c89d68',        // Dourado (títulos)
  green: '#059669',       // Verde (positivo)
  red: '#dc2626',         // Vermelho (negativo)
  grayText: '#6b7280',    // Cinza texto
  grayBorder: '#e5e7eb',  // Cinza bordas
  black: '#000000',
  white: '#ffffff',
};

// Caminho da logo
const LOGO_PATH = path.join(__dirname, '../../assets/vitall-logo.png');

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

/** Desenha o header profissional com logo e títulos */
function drawProfessionalHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  monthTitle: string,
  pageWidth: number,
  margin: number,
): number {
  const M = margin;
  let y = M;

  // Logo no canto superior esquerdo
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, M, y, { width: 120 });
  }

  // Espaço após logo
  y += 90;

  // Título centralizado em dourado
  doc.fontSize(16).font('Helvetica-Bold').fillColor(C.gold);
  doc.text(title.toUpperCase(), M, y, { width: pageWidth, align: 'center' });
  y += 25;

  // Subtítulo "MÊS: XXX 2026" centralizado
  doc.fontSize(14).font('Helvetica-Bold').fillColor(C.gold);
  doc.text(`MÊS: ${monthTitle.toUpperCase()}`, M, y, { width: pageWidth, align: 'center' });
  y += 40;

  return y;
}

/** Gera PDF de Conta Corrente */
/** Gera PDF de Conta Corrente com layout profissional */
async function generateContaCorrentePDF(yearMonth: string, lancamentos: LancamentoContaCorrente[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 15, bottom: 15, left: 25, right: 25 }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const M = 25; // margin lateral
    const MT = 15; // margin topo
    const PW = doc.page.width - M * 2;

    // Header profissional com logo
    let y = drawProfessionalHeader(doc, 'Conta Corrente', titleMonth, PW, M);

    // Tabela - 5 colunas centralizadas
    const colW = [100, 120, 250, 180, 120]; // Data | Tipo | Descrição | Contraparte | Valor
    const TW = colW.reduce((a, b) => a + b, 0);
    const TX = M + (PW - TW) / 2; // Centralizar tabela

    // Header da tabela (teal com texto branco)
    const thH = 30;
    doc.rect(TX, y, TW, thH).fill(C.teal);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white);
    const headers = ['DATA', 'TIPO', 'DESCRIÇÃO', 'CONTRAPARTE', 'VALOR'];
    let cx = TX;
    for (let i = 0; i < 5; i++) {
      doc.text(headers[i], cx, y + 10, { width: colW[i], align: 'center' });
      cx += colW[i];
    }
    y += thH;

    // Linhas de dados
    let totalVendas = 0;
    let totalEntradas = 0;
    let totalSaidas = 0;
    let rowIndex = 0;

    for (const lanc of lancamentos) {
      const rowH = 25;

      // Page break
      if (y + rowH > doc.page.height - 80) {
        doc.addPage();
        y = drawProfessionalHeader(doc, 'Conta Corrente', titleMonth, PW, M);
        // Re-desenhar header da tabela
        doc.rect(TX, y, TW, thH).fill(C.teal);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white);
        cx = TX;
        for (let i = 0; i < 5; i++) {
          doc.text(headers[i], cx, y + 10, { width: colW[i], align: 'center' });
          cx += colW[i];
        }
        y += thH;
        rowIndex = 0;
      }

      // Background alternado (branco / teal claro)
      const bg = rowIndex % 2 === 0 ? C.white : C.tealLight;
      doc.rect(TX, y, TW, rowH).fill(bg);

      // Bordas
      doc.lineWidth(0.5).strokeColor(C.grayBorder);
      doc.moveTo(TX, y).lineTo(TX + TW, y).stroke();
      doc.moveTo(TX, y + rowH).lineTo(TX + TW, y + rowH).stroke();

      // Dados centralizados
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      cx = TX;

      // Data
      doc.text(formatDate(lanc.data), cx, y + 7, { width: colW[0], align: 'center' });
      cx += colW[0];

      // Tipo
      doc.text(lanc.tipo.toUpperCase(), cx, y + 7, { width: colW[1], align: 'center' });
      cx += colW[1];

      // Descrição
      doc.text((lanc.descricao || '').substring(0, 40), cx + 5, y + 7, { width: colW[2] - 10, align: 'left' });
      cx += colW[2];

      // Contraparte
      doc.text((lanc.contraparte || '').substring(0, 25), cx, y + 7, { width: colW[3], align: 'center' });
      cx += colW[3];

      // Valor
      doc.text(formatBRL(lanc.valor), cx, y + 7, { width: colW[4], align: 'center' });

      // Somar totais
      if (lanc.tipo === 'venda') totalVendas += lanc.valor;
      else if (lanc.tipo === 'entrada') totalEntradas += lanc.valor;
      else totalSaidas += lanc.valor;

      y += rowH;
      rowIndex++;
    }

    // Rodapé com totais
    y += 20;
    if (y > doc.page.height - 100) {
      doc.addPage();
      y = M + 150;
    }

    const resumoW = 400;
    const resumoX = M + (PW - resumoW) / 2;

    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO FINANCEIRO', M, y, { width: PW, align: 'center' });
    y += 25;

    const itemH = 22;
    // Total Vendas
    doc.rect(resumoX, y, resumoW, itemH).fill(C.tealLight);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Total Vendas', resumoX + 10, y + 6, { width: 200 });
    doc.text(formatBRL(totalVendas), resumoX + 210, y + 6, { width: 180, align: 'right' });
    y += itemH;

    // Total Entradas
    doc.rect(resumoX, y, resumoW, itemH).fill(C.white);
    doc.text('Total Entradas', resumoX + 10, y + 6, { width: 200 });
    doc.text(formatBRL(totalEntradas), resumoX + 210, y + 6, { width: 180, align: 'right' });
    y += itemH;

    // Total Saídas
    doc.rect(resumoX, y, resumoW, itemH).fill(C.tealLight);
    doc.text('Total Saídas', resumoX + 10, y + 6, { width: 200 });
    doc.text(formatBRL(totalSaidas), resumoX + 210, y + 6, { width: 180, align: 'right' });
    y += itemH;

    // Saldo
    const saldo = totalVendas + totalEntradas - totalSaidas;
    const saldoColor = saldo >= 0 ? C.green : C.red;
    doc.rect(resumoX, y, resumoW, itemH + 5).fill(C.teal);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.white);
    doc.text('SALDO DO MÊS', resumoX + 10, y + 8, { width: 200 });
    doc.fillColor(C.white).text(formatBRL(saldo), resumoX + 210, y + 8, { width: 180, align: 'right' });

    // Rodapé
    y += 50;
    const now = new Date();
    const geradoEm = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
    doc.text(`Documento gerado em ${geradoEm} - Vitall Odontologia`, M, y, { width: PW, align: 'center' });

    doc.end();
  });
}


/** Gera PDF de Contas a Pagar com layout profissional */
async function generateContasPagarPDF(yearMonth: string, contas: ContaPagar[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 15, bottom: 15, left: 25, right: 25 }
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const M = 25; // margin lateral
    const MT = 15; // margin topo
    const PW = doc.page.width - M * 2;

    // Header profissional com logo
    let y = drawProfessionalHeader(doc, 'Contas a Pagar', titleMonth, PW, M);

    // Tabela - 6 colunas centralizadas
    const colW = [90, 200, 120, 120, 100, 80]; // Venc | Descrição | Categoria | Classif | Valor | Status
    const TW = colW.reduce((a, b) => a + b, 0);
    const TX = M + (PW - TW) / 2;

    // Header da tabela (teal com texto branco)
    const thH = 30;
    doc.rect(TX, y, TW, thH).fill(C.teal);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white);
    const headers = ['VENCIMENTO', 'DESCRIÇÃO', 'CATEGORIA', 'CLASSIFICAÇÃO', 'VALOR', 'STATUS'];
    let cx = TX;
    for (let i = 0; i < 6; i++) {
      doc.text(headers[i], cx, y + 10, { width: colW[i], align: 'center' });
      cx += colW[i];
    }
    y += thH;

    // Linhas de dados
    const resumo = new Map<string, number>();
    let totalAberto = 0;
    let totalPago = 0;
    let rowIndex = 0;

    for (const conta of contas) {
      const rowH = 25;

      // Page break
      if (y + rowH > doc.page.height - 80) {
        doc.addPage();
        y = drawProfessionalHeader(doc, 'Contas a Pagar', titleMonth, PW, M);
        // Re-desenhar header
        doc.rect(TX, y, TW, thH).fill(C.teal);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white);
        cx = TX;
        for (let i = 0; i < 6; i++) {
          doc.text(headers[i], cx, y + 10, { width: colW[i], align: 'center' });
          cx += colW[i];
        }
        y += thH;
        rowIndex = 0;
      }

      // Background alternado
      const bg = rowIndex % 2 === 0 ? C.white : C.tealLight;
      doc.rect(TX, y, TW, rowH).fill(bg);

      // Bordas
      doc.lineWidth(0.5).strokeColor(C.grayBorder);
      doc.moveTo(TX, y).lineTo(TX + TW, y).stroke();
      doc.moveTo(TX, y + rowH).lineTo(TX + TW, y + rowH).stroke();

      // Dados centralizados
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      cx = TX;

      // Vencimento
      doc.text(formatDate(conta.vencimento), cx, y + 7, { width: colW[0], align: 'center' });
      cx += colW[0];

      // Descrição
      doc.text((conta.descricao || '').substring(0, 35), cx + 5, y + 7, { width: colW[1] - 10, align: 'left' });
      cx += colW[1];

      // Categoria
      doc.text((conta.categoria || '').substring(0, 18), cx, y + 7, { width: colW[2], align: 'center' });
      cx += colW[2];

      // Classificação
      doc.text((conta.classificacao || '').substring(0, 18), cx, y + 7, { width: colW[3], align: 'center' });
      cx += colW[3];

      // Valor
      doc.text(formatBRL(conta.valor), cx, y + 7, { width: colW[4], align: 'center' });
      cx += colW[4];

      // Status
      const statusLabel = conta.status === 'realizado' ? 'PAGO' : 'ABERTO';
      doc.text(statusLabel, cx, y + 7, { width: colW[5], align: 'center' });

      // Resumo
      const classif = conta.classificacao || 'Outros';
      resumo.set(classif, (resumo.get(classif) || 0) + conta.valor);

      if (conta.status === 'realizado') totalPago += conta.valor;
      else totalAberto += conta.valor;

      y += rowH;
      rowIndex++;
    }

    // Resumo por classificação
    y += 30;
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = M + 150;
    }

    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('RESUMO POR CLASSIFICAÇÃO', M, y, { width: PW, align: 'center' });
    y += 25;

    const resumoW = 400;
    const resumoX = M + (PW - resumoW) / 2;

    let resumoIndex = 0;
    for (const [classif, total] of resumo) {
      const itemH = 22;
      const bg = resumoIndex % 2 === 0 ? C.tealLight : C.white;
      doc.rect(resumoX, y, resumoW, itemH).fill(bg);
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text(classif, resumoX + 10, y + 6, { width: 200 });
      doc.text(formatBRL(total), resumoX + 210, y + 6, { width: 180, align: 'right' });
      y += itemH;
      resumoIndex++;
    }

    // Totais finais
    y += 20;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.gold);
    doc.text('TOTAIS', M, y, { width: PW, align: 'center' });
    y += 25;

    const itemH = 22;
    // Total Aberto
    doc.rect(resumoX, y, resumoW, itemH).fill(C.tealLight);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Total Aberto', resumoX + 10, y + 6, { width: 200 });
    doc.fillColor(C.red).text(formatBRL(totalAberto), resumoX + 210, y + 6, { width: 180, align: 'right' });
    y += itemH;

    // Total Pago
    doc.rect(resumoX, y, resumoW, itemH).fill(C.white);
    doc.fillColor(C.black).text('Total Pago', resumoX + 10, y + 6, { width: 200 });
    doc.fillColor(C.green).text(formatBRL(totalPago), resumoX + 210, y + 6, { width: 180, align: 'right' });
    y += itemH;

    // Total Geral
    const totalGeral = totalAberto + totalPago;
    doc.rect(resumoX, y, resumoW, itemH + 5).fill(C.teal);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.white);
    doc.text('TOTAL GERAL', resumoX + 10, y + 8, { width: 200 });
    doc.text(formatBRL(totalGeral), resumoX + 210, y + 8, { width: 180, align: 'right' });

    // Rodapé
    y += 50;
    const now = new Date();
    const geradoEm = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
    doc.text(`Documento gerado em ${geradoEm} - Vitall Odontologia`, M, y, { width: PW, align: 'center' });

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

    // 2. Fetch dados
    const [lancamentos, contas] = await Promise.all([
      fetchContaCorrente(yearMonth),
      fetchContasPagar(yearMonth),
    ]);

    if (lancamentos.length === 0 && contas.length === 0) {
      console.log('[FinReport] Nenhum dado financeiro encontrado para o mês. Abortando.');
      await sendText(env.JESSICA_PHONE, `⚠️ *Relatório Financeiro Mensal*\n\nNenhum dado encontrado para ${monthTitle}. Verifique o banco de dados.`);
      return;
    }

    // 3. Gerar PDFs
    console.log('[FinReport] Gerando PDFs...');
    const [contaCorrentePDF, contasPagarPDF] = await Promise.all([
      generateContaCorrentePDF(yearMonth, lancamentos),
      generateContasPagarPDF(yearMonth, contas),
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

    // 5. Enviar email para contabilidade
    const emailSent = await gmail.sendEmail(
      env.ACCOUNTANT_EMAIL,
      `Relatórios Financeiros - ${monthTitle} - Vitall Odontologia`,
      `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        </head>
        <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
          <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

            <!-- Header -->
            <div style="background: linear-gradient(135deg, #277d7e 0%, #1f6364 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">
                Relatórios Financeiros
              </h1>
              <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 18px; font-weight: 400;">
                ${monthTitle}
              </p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <p style="margin: 0 0 25px 0; color: #333; font-size: 16px; line-height: 1.6;">
                Excelente dia,
              </p>

              <p style="margin: 0 0 30px 0; color: #555; font-size: 15px; line-height: 1.6;">
                Seguem os relatórios financeiros da <strong style="color: #277d7e;">Vitall Odontologia</strong> referentes ao mês de <strong>${monthTitle}</strong>:
              </p>

              <!-- PDFs -->
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 25px; margin-bottom: 30px;">
                <div style="margin-bottom: 15px;">
                  <a href="${contaCorrenteLink.webViewLink}"
                     style="display: inline-block; width: 100%; padding: 16px 24px; background-color: #277d7e; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; text-align: center; transition: background-color 0.3s;">
                    Conta Corrente - ${monthTitle}
                  </a>
                </div>
                <div>
                  <a href="${contasPagarLink.webViewLink}"
                     style="display: inline-block; width: 100%; padding: 16px 24px; background-color: #277d7e; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; text-align: center; transition: background-color 0.3s;">
                    Contas a Pagar - ${monthTitle}
                  </a>
                </div>
              </div>

              <!-- Drive Folder -->
              <div style="text-align: center; padding: 20px; background-color: #f0fffe; border: 2px dashed #277d7e; border-radius: 8px;">
                <p style="margin: 0 0 12px 0; color: #555; font-size: 14px;">
                  Acesse todos os arquivos na pasta do Google Drive:
                </p>
                <a href="${folderLink}"
                   style="display: inline-block; padding: 12px 28px; background-color: #ffffff; color: #277d7e; text-decoration: none; border: 2px solid #277d7e; border-radius: 6px; font-weight: 600; font-size: 15px;">
                  📁 Abrir Pasta
                </a>
              </div>
            </div>

            <!-- Footer -->
            <div style="background-color: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px 0; color: #277d7e; font-weight: 600; font-size: 16px;">
                Vitall Odontologia
              </p>
              <p style="margin: 0; color: #999; font-size: 13px; line-height: 1.5;">
                Este email foi gerado automaticamente pelo sistema VitallAssistente<br>
                Dúvidas? Entre em contato conosco.
              </p>
            </div>

          </div>
        </body>
        </html>
      `,
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
