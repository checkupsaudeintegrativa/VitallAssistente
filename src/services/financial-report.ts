import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import * as drive from './google-drive';
import * as gmail from './gmail';
import { sendText } from './evolution';

// Supabase — mesmo banco do Precificação (compartilhado com VitallAssistente)
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// Cores do PDF (padrão Vitall)
const C = {
  primary: '#1db9b3',
  secondary: '#c89d68',
  green: '#059669',
  red: '#dc2626',
  grayText: '#6b7280',
  grayBorder: '#e5e7eb',
  black: '#000000',
  white: '#ffffff',
};

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

/** Gera PDF de Conta Corrente */
async function generateContaCorrentePDF(yearMonth: string, lancamentos: LancamentoContaCorrente[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const M = 40; // margin
    const PW = doc.page.width - M * 2;

    // Header
    doc.fontSize(16).font('Helvetica-Bold').fillColor(C.secondary);
    doc.text(`CONTA CORRENTE — ${titleMonth}`, M, M, { align: 'center', width: PW });
    doc.moveDown(1);

    // Linha separadora
    doc.moveTo(M, doc.y).lineTo(M + PW, doc.y).lineWidth(1).strokeColor(C.grayBorder).stroke();
    doc.moveDown(0.5);

    // Tabela
    const colW = [80, 70, 200, 150, 100]; // Data | Tipo | Descrição | Contraparte | Valor
    const tableX = M;
    let y = doc.y;

    // Header da tabela
    const thH = 20;
    doc.rect(tableX, y, PW, thH).fill(C.primary);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.white);
    const headers = ['Data', 'Tipo', 'Descrição', 'Contraparte', 'Valor'];
    let cx = tableX;
    for (let i = 0; i < 5; i++) {
      doc.text(headers[i], cx + 4, y + 5, { width: colW[i] - 8, align: i === 4 ? 'right' : 'left' });
      cx += colW[i];
    }
    y += thH;

    // Linhas de dados
    let totalVendas = 0;
    let totalEntradas = 0;
    let totalSaidas = 0;

    for (const lanc of lancamentos) {
      const rowH = 18;

      // Page break
      if (y + rowH > doc.page.height - 100) {
        doc.addPage();
        y = M;
      }

      // Background
      doc.rect(tableX, y, PW, rowH).fill(C.white);

      // Bordas
      doc.lineWidth(0.5).strokeColor(C.grayBorder);
      doc.moveTo(tableX, y).lineTo(tableX + PW, y).stroke();
      doc.moveTo(tableX, y + rowH).lineTo(tableX + PW, y + rowH).stroke();

      // Dados
      doc.fontSize(8).font('Helvetica').fillColor(C.black);
      cx = tableX;

      // Data
      doc.text(formatDate(lanc.data), cx + 4, y + 5, { width: colW[0] - 8 });
      cx += colW[0];

      // Tipo (colorido)
      const tipoColor = lanc.tipo === 'venda' || lanc.tipo === 'entrada' ? C.green : C.red;
      const tipoLabel = lanc.tipo === 'venda' ? 'Venda' : lanc.tipo === 'entrada' ? 'Entrada' : 'Saída';
      doc.fillColor(tipoColor).text(tipoLabel, cx + 4, y + 5, { width: colW[1] - 8 });
      cx += colW[1];

      // Descrição
      doc.fillColor(C.black).text((lanc.descricao || '').substring(0, 50), cx + 4, y + 5, { width: colW[2] - 8 });
      cx += colW[2];

      // Contraparte
      doc.text((lanc.contraparte || '').substring(0, 30), cx + 4, y + 5, { width: colW[3] - 8 });
      cx += colW[3];

      // Valor
      const valorColor = lanc.tipo === 'venda' || lanc.tipo === 'entrada' ? C.green : C.red;
      doc.fillColor(valorColor).text(formatBRL(lanc.valor), cx + 4, y + 5, { width: colW[4] - 8, align: 'right' });

      // Somar totais
      if (lanc.tipo === 'venda') totalVendas += lanc.valor;
      else if (lanc.tipo === 'entrada') totalEntradas += lanc.valor;
      else totalSaidas += lanc.valor;

      y += rowH;
    }

    // Rodapé com totais
    y += 10;
    const footH = 60;
    if (y + footH > doc.page.height - 40) {
      doc.addPage();
      y = M;
    }

    doc.lineWidth(2).strokeColor(C.black);
    doc.rect(tableX, y, PW, footH).stroke();

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    const labelX = tableX + 10;
    const valueX = tableX + PW - 120;

    doc.text('Total Vendas:', labelX, y + 8);
    doc.fillColor(C.green).text(formatBRL(totalVendas), valueX, y + 8, { width: 110, align: 'right' });

    doc.fillColor(C.black).text('Total Entradas:', labelX, y + 23);
    doc.fillColor(C.green).text(formatBRL(totalEntradas), valueX, y + 23, { width: 110, align: 'right' });

    doc.fillColor(C.black).text('Total Saídas:', labelX, y + 38);
    doc.fillColor(C.red).text(formatBRL(totalSaidas), valueX, y + 38, { width: 110, align: 'right' });

    const saldo = totalVendas + totalEntradas - totalSaidas;
    y += footH + 5;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Saldo do Mês:', labelX, y);
    const saldoColor = saldo >= 0 ? C.green : C.red;
    doc.fillColor(saldoColor).text(formatBRL(saldo), valueX, y, { width: 110, align: 'right' });

    // Rodapé
    y += 30;
    const now = new Date();
    const geradoEm = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Documento gerado em ${geradoEm} - Vitall Odontologia`, tableX, y, { width: PW, align: 'center' });

    doc.end();
  });
}

/** Gera PDF de Contas a Pagar */
async function generateContasPagarPDF(yearMonth: string, contas: ContaPagar[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [year, month] = yearMonth.split('-');
    const monthName = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const titleMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const M = 40;
    const PW = doc.page.width - M * 2;

    // Header
    doc.fontSize(16).font('Helvetica-Bold').fillColor(C.secondary);
    doc.text(`CONTAS A PAGAR — ${titleMonth}`, M, M, { align: 'center', width: PW });
    doc.moveDown(1);

    // Linha separadora
    doc.moveTo(M, doc.y).lineTo(M + PW, doc.y).lineWidth(1).strokeColor(C.grayBorder).stroke();
    doc.moveDown(0.5);

    // Tabela
    const colW = [70, 150, 100, 110, 80, 60]; // Vencimento | Descrição | Categoria | Classificação | Valor | Status
    const tableX = M;
    let y = doc.y;

    // Header da tabela
    const thH = 20;
    doc.rect(tableX, y, PW, thH).fill(C.primary);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.white);
    const headers = ['Vencimento', 'Descrição', 'Categoria', 'Classificação', 'Valor', 'Status'];
    let cx = tableX;
    for (let i = 0; i < 6; i++) {
      doc.text(headers[i], cx + 4, y + 5, { width: colW[i] - 8, align: i === 4 ? 'right' : 'left' });
      cx += colW[i];
    }
    y += thH;

    // Linhas de dados
    const resumo = new Map<string, number>();
    let totalAberto = 0;
    let totalPago = 0;

    for (const conta of contas) {
      const rowH = 18;

      if (y + rowH > doc.page.height - 120) {
        doc.addPage();
        y = M;
      }

      doc.rect(tableX, y, PW, rowH).fill(C.white);
      doc.lineWidth(0.5).strokeColor(C.grayBorder);
      doc.moveTo(tableX, y).lineTo(tableX + PW, y).stroke();
      doc.moveTo(tableX, y + rowH).lineTo(tableX + PW, y + rowH).stroke();

      doc.fontSize(8).font('Helvetica').fillColor(C.black);
      cx = tableX;

      // Vencimento
      doc.text(formatDate(conta.vencimento), cx + 4, y + 5, { width: colW[0] - 8 });
      cx += colW[0];

      // Descrição
      doc.text((conta.descricao || '').substring(0, 35), cx + 4, y + 5, { width: colW[1] - 8 });
      cx += colW[1];

      // Categoria
      doc.text((conta.categoria || '').substring(0, 20), cx + 4, y + 5, { width: colW[2] - 8 });
      cx += colW[2];

      // Classificação
      doc.text((conta.classificacao || '').substring(0, 20), cx + 4, y + 5, { width: colW[3] - 8 });
      cx += colW[3];

      // Valor
      const valorColor = conta.status === 'realizado' ? C.red : C.grayText;
      doc.fillColor(valorColor).text(formatBRL(conta.valor), cx + 4, y + 5, { width: colW[4] - 8, align: 'right' });
      cx += colW[4];

      // Status
      const statusColor = conta.status === 'realizado' ? C.green : C.red;
      const statusLabel = conta.status === 'realizado' ? 'Pago' : 'Aberto';
      doc.fillColor(statusColor).text(statusLabel, cx + 4, y + 5, { width: colW[5] - 8, align: 'center' });

      // Resumo por classificação
      const classif = conta.classificacao || 'Outros';
      resumo.set(classif, (resumo.get(classif) || 0) + conta.valor);

      if (conta.status === 'realizado') totalPago += conta.valor;
      else totalAberto += conta.valor;

      y += rowH;
    }

    // Resumo por classificação
    y += 10;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Resumo por Classificação:', tableX, y);
    y += 15;

    for (const [classif, total] of resumo) {
      doc.fontSize(9).font('Helvetica').fillColor(C.black);
      doc.text(`• ${classif}:`, tableX + 10, y);
      doc.text(formatBRL(total), tableX + PW - 100, y, { width: 90, align: 'right' });
      y += 14;
    }

    // Rodapé com totais
    y += 10;
    const footH = 50;
    if (y + footH > doc.page.height - 40) {
      doc.addPage();
      y = M;
    }

    doc.lineWidth(2).strokeColor(C.black);
    doc.rect(tableX, y, PW, footH).stroke();

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    const labelX = tableX + 10;
    const valueX = tableX + PW - 120;

    doc.text('Total Aberto:', labelX, y + 8);
    doc.fillColor(C.red).text(formatBRL(totalAberto), valueX, y + 8, { width: 110, align: 'right' });

    doc.fillColor(C.black).text('Total Pago:', labelX, y + 25);
    doc.fillColor(C.green).text(formatBRL(totalPago), valueX, y + 25, { width: 110, align: 'right' });

    const totalGeral = totalAberto + totalPago;
    y += footH + 5;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Total Geral:', labelX, y);
    doc.text(formatBRL(totalGeral), valueX, y, { width: 110, align: 'right' });

    // Rodapé
    y += 30;
    const now = new Date();
    const geradoEm = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
    doc.text(`Documento gerado em ${geradoEm} - Vitall Odontologia`, tableX, y, { width: PW, align: 'center' });

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
        </head>
        <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
          <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

            <!-- Header -->
            <div style="background: linear-gradient(135deg, #1db9b3 0%, #17a39d 100%); padding: 40px 30px; text-align: center;">
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
                Seguem os relatórios financeiros da <strong style="color: #1db9b3;">Vitall Odontologia</strong> referentes ao mês de <strong>${monthTitle}</strong>:
              </p>

              <!-- PDFs -->
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 25px; margin-bottom: 30px;">
                <div style="margin-bottom: 15px;">
                  <a href="${contaCorrenteLink.webViewLink}"
                     style="display: inline-block; width: 100%; padding: 16px 24px; background-color: #1db9b3; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; text-align: center; transition: background-color 0.3s;">
                    📊 Conta Corrente - ${monthTitle}
                  </a>
                </div>
                <div>
                  <a href="${contasPagarLink.webViewLink}"
                     style="display: inline-block; width: 100%; padding: 16px 24px; background-color: #1db9b3; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; text-align: center; transition: background-color 0.3s;">
                    📋 Contas a Pagar - ${monthTitle}
                  </a>
                </div>
              </div>

              <!-- Drive Folder -->
              <div style="text-align: center; padding: 20px; background-color: #f0fffe; border: 2px dashed #1db9b3; border-radius: 8px;">
                <p style="margin: 0 0 12px 0; color: #555; font-size: 14px;">
                  Acesse todos os arquivos na pasta do Google Drive:
                </p>
                <a href="${folderLink}"
                   style="display: inline-block; padding: 12px 28px; background-color: #ffffff; color: #1db9b3; text-decoration: none; border: 2px solid #1db9b3; border-radius: 6px; font-weight: 600; font-size: 15px;">
                  📁 Abrir Pasta
                </a>
              </div>
            </div>

            <!-- Footer -->
            <div style="background-color: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px 0; color: #1db9b3; font-weight: 600; font-size: 16px;">
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
