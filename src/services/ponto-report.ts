import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { parseISO, differenceInMinutes } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';

const TZ = 'America/Sao_Paulo';

// Client separado — banco do Controle de Ponto (funcionarios, registros_ponto)
// Lazy init para não crashar se as variáveis não estiverem configuradas
let _supabasePonto: ReturnType<typeof createClient> | null = null;
function getSupabasePonto() {
  if (!_supabasePonto) {
    if (!env.SUPABASE_PONTO_URL || !env.SUPABASE_PONTO_KEY) {
      throw new Error('SUPABASE_PONTO_URL e SUPABASE_PONTO_KEY não configuradas');
    }
    _supabasePonto = createClient(env.SUPABASE_PONTO_URL, env.SUPABASE_PONTO_KEY);
  }
  return _supabasePonto;
}

// ── Types ──

interface Funcionario {
  id: string;
  nome: string;
  carga_horaria_diaria_minutos: number;
  horarios?: Record<string, { ativo: boolean }>;
  saldo_acumulado_minutos?: number;
  saldo_data_referencia?: string | null;
}

interface RegistroPonto {
  id: string;
  funcionario_id: string;
  nome_funcionario: string;
  data_hora: string;
  tipo: string;
}

interface ParPontos {
  entrada: string;
  saida: string | null;
  minutos: number;
}

interface ResumoDay {
  data: string;            // DD/MM/YYYY
  diaSemana: string;       // Segunda-feira, ...
  isWeekend: boolean;
  pares: ParPontos[];
  trabalhado: number;
  esperado: number;
  saldo: number;
}

interface EmployeeReport {
  nome: string;
  dias: ResumoDay[];
  totalTrabalhado: number;
  totalEsperado: number;
  totalSaldo: number;
  saldoAcumuladoTotal?: number;
}

// ── Helpers ──

function minutosParaHoras(minutos: number): string {
  const sinal = minutos < 0 ? '-' : '';
  const abs = Math.abs(minutos);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sinal}${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function fmtHour(isoStr: string): string {
  try {
    const d = parseISO(isoStr);
    if (isNaN(d.getTime())) return '--:--';
    return formatInTimeZone(d, TZ, 'HH:mm');
  } catch {
    return '--:--';
  }
}

/** Formata Date UTC (datas de período) como DD/MM/YYYY */
function fmtDateBR(d: Date): string {
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Horas esperadas por dia da semana (regra Vitall: Seg-Qui 9h, Sex 8h) */
function horasEsperadasDia(dow: number): number {
  if (dow >= 1 && dow <= 4) return 540; // Seg-Qui: 9h
  if (dow === 5) return 480;            // Sex: 8h
  return 0;                              // Sáb-Dom: 0
}

// ── Data fetching ──

async function fetchFuncionarios(): Promise<Funcionario[]> {
  const { data, error } = await getSupabasePonto()
    .from('funcionarios')
    .select('id, nome, carga_horaria_diaria_minutos, horarios, saldo_acumulado_minutos, saldo_data_referencia')
    .order('nome');
  if (error) {
    console.error('[PontoReport] Erro ao buscar funcionários:', error.message);
    return [];
  }
  return data || [];
}

async function fetchRegistros(startISO: string, endISO: string): Promise<RegistroPonto[]> {
  const { data, error } = await getSupabasePonto()
    .from('registros_ponto')
    .select('id, funcionario_id, nome_funcionario, data_hora, tipo')
    .gte('data_hora', startISO)
    .lte('data_hora', endISO)
    .order('data_hora', { ascending: true });
  if (error) {
    console.error('[PontoReport] Erro ao buscar registros:', error.message);
    return [];
  }
  return data || [];
}

// ── Week period ──

function calcWeekPeriod(): { start: Date; end: Date } {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = todayUTC.getUTCDay();
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;

  const start = new Date(todayUTC);
  start.setUTCDate(start.getUTCDate() - daysSinceMonday - 7);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  return { start, end };
}

// ── Report calculation ──

function buildEmployeeReport(
  func: Funcionario,
  registros: RegistroPonto[],
  start: Date,
  end: Date,
): EmployeeReport {
  const funcRegs = registros.filter((r) => r.funcionario_id === func.id);

  // Agrupar por data BRT
  const byDate = new Map<string, RegistroPonto[]>();
  for (const r of funcRegs) {
    const d = parseISO(r.data_hora);
    if (isNaN(d.getTime())) continue;
    const key = formatInTimeZone(d, TZ, 'dd/MM/yyyy');
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r);
  }

  const dias: ResumoDay[] = [];
  let totalTrabalhado = 0;
  let totalEsperado = 0;
  let totalSaldo = 0;

  const cursor = new Date(start);
  while (cursor <= end) {
    // Adicionar 12h ao cursor UTC para evitar que midnight UTC vire dia anterior em BRT
    const cursorMid = new Date(cursor.getTime() + 12 * 60 * 60 * 1000);
    const dateKey = formatInTimeZone(cursorMid, TZ, 'dd/MM/yyyy');
    const dow = cursor.getUTCDay();
    const esperado = horasEsperadasDia(dow);
    const weekend = dow === 0 || dow === 6;

    const recs = byDate.get(dateKey) || [];
    recs.sort((a, b) => new Date(a.data_hora).getTime() - new Date(b.data_hora).getTime());

    const pares: ParPontos[] = [];
    let trabalhado = 0;
    for (let i = 0; i < recs.length; i += 2) {
      const ent = recs[i];
      const sai = i + 1 < recs.length ? recs[i + 1] : null;
      if (ent && sai) {
        const mins = Math.max(0, differenceInMinutes(parseISO(sai.data_hora), parseISO(ent.data_hora)));
        trabalhado += mins;
        pares.push({ entrada: fmtHour(ent.data_hora), saida: fmtHour(sai.data_hora), minutos: mins });
      } else if (ent) {
        pares.push({ entrada: fmtHour(ent.data_hora), saida: null, minutos: 0 });
      }
    }

    const saldo = trabalhado - esperado;
    totalTrabalhado += trabalhado;
    totalEsperado += esperado;
    totalSaldo += saldo;

    const diaSemanaFull = formatInTimeZone(cursorMid, TZ, 'EEEE', { locale: ptBR });

    dias.push({
      data: dateKey,
      diaSemana: diaSemanaFull.charAt(0).toUpperCase() + diaSemanaFull.slice(1),
      isWeekend: weekend,
      pares,
      trabalhado,
      esperado,
      saldo,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { nome: func.nome, dias, totalTrabalhado, totalEsperado, totalSaldo };
}

// ══════════════════════════════════════════════════════════════════════
// PDF generation — clone exato do calendário semanal do Controle-de-ponto
// ══════════════════════════════════════════════════════════════════════

// Cores do app web (tailwind.config + inline styles)
const C = {
  primary:   '#1db9b3',   // bg-primary (header da tabela)
  tealDark:  '#137B76',   // rgb(19,123,118) — footer totais
  secondary: '#c89d68',   // text-secondary — título
  green:     '#059669',   // text-green-600 — entradas
  red:       '#dc2626',   // text-red-600 — saídas
  grayText:  '#6b7280',   // text-gray-500
  grayLight: '#9ca3af',   // text-gray-400 (setas, duração)
  grayBorder:'#e5e7eb',   // border padrão
  rowAlt:    '#f4fefe',   // bg-primary/5 (linhas alternadas)
  weekendBg: '#fffbeb',   // bg-amber-50
  greenBg:   '#dcfce7',   // bg-green-100
  greenText: '#166534',   // text-green-800
  redBg:     '#fee2e2',   // bg-red-100
  redText:   '#991b1b',   // text-red-800
  black:     '#000000',
  white:     '#ffffff',
};

function generateEmployeePDF(report: EmployeeReport, start: Date, end: Date): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 28; // margin
    const PW = doc.page.width - M * 2; // usable page width

    // ────────── HEADER (replica print:flex header) ──────────
    doc.fontSize(15).font('Helvetica-Bold').fillColor(C.secondary)
      .text(`REGISTRO DE PONTO SEMANAL - ${report.nome.toUpperCase()}`, M, M, { align: 'center', width: PW });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(C.secondary)
      .text(`PERÍODO: ${fmtDateBR(start)} a ${fmtDateBR(end)}`, { align: 'center', width: PW });
    doc.moveDown(0.3);

    // Linha separadora sob o header
    const sepY = doc.y;
    doc.moveTo(M, sepY).lineTo(M + PW, sepY).lineWidth(1).strokeColor(C.grayBorder).stroke();
    doc.moveDown(0.6);

    // ────────── TABLE ──────────
    // 5 colunas (sem "Ações" que é no-print)
    const colW = [
      Math.round(PW * 0.17),   // Dia
      Math.round(PW * 0.35),   // Registros de Ponto
      Math.round(PW * 0.16),   // Horas Trabalhadas
      Math.round(PW * 0.16),   // Horas Esperadas
      0,                        // Saldo (restante)
    ];
    colW[4] = PW - colW[0] - colW[1] - colW[2] - colW[3];
    const TW = PW; // total table width = full page
    const TX = M;  // table X

    const HEADERS = ['Dia', 'Registros de Ponto', 'Horas Trabalhadas', 'Horas Esperadas', 'Saldo'];

    // ── Thead ──
    const thH = 24;
    let y = doc.y;
    doc.rect(TX, y, TW, thH).fill(C.primary);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.white);
    let cx = TX;
    for (let i = 0; i < 5; i++) {
      doc.text(HEADERS[i], cx + 4, y + 7, { width: colW[i] - 8, align: i === 0 ? 'left' : 'center' });
      cx += colW[i];
    }
    y += thH;

    // ── Tbody ──
    for (let ri = 0; ri < report.dias.length; ri++) {
      const dia = report.dias[ri];
      const pairCount = Math.max(1, dia.pares.length);
      const ROW_H = Math.max(30, pairCount * 16 + 10);

      // Page break check
      if (y + ROW_H > doc.page.height - 130) {
        doc.addPage();
        y = M;
      }

      // Row background
      const bg = dia.isWeekend ? C.weekendBg : (ri % 2 === 1 ? C.rowAlt : C.white);
      doc.rect(TX, y, TW, ROW_H).fill(bg);

      // Cell borders (thin gray)
      doc.lineWidth(0.5).strokeColor(C.grayBorder);
      // Horizontal top + bottom
      doc.moveTo(TX, y).lineTo(TX + TW, y).stroke();
      doc.moveTo(TX, y + ROW_H).lineTo(TX + TW, y + ROW_H).stroke();
      // Vertical separators
      let bx = TX;
      for (let i = 0; i <= 5; i++) {
        doc.moveTo(bx, y).lineTo(bx, y + ROW_H).stroke();
        if (i < 5) bx += colW[i];
      }

      // ── Col 0: Dia ──
      const c0x = TX + 6;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.black);
      doc.text(dia.diaSemana, c0x, y + 5, { width: colW[0] - 12, lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(C.grayText);
      doc.text(dia.data, c0x, y + 18, { width: colW[0] - 12, lineBreak: false });

      // ── Col 1: Registros de Ponto ──
      const c1x = TX + colW[0];
      const c1w = colW[1];
      if (dia.pares.length > 0) {
        const blockH = dia.pares.length * 16;
        let py = y + (ROW_H - blockH) / 2;

        for (const par of dia.pares) {
          const h = Math.floor(par.minutos / 60);
          const m = par.minutos % 60;
          const durStr = par.minutos > 0 ? `(${h}h${m}m)` : '';

          const entW = 35;
          const arrW = 22;
          const saiW = 35;
          const durW = 50;
          const totalSegW = entW + arrW + saiW + durW;
          const startX = c1x + (c1w - totalSegW) / 2;

          doc.fontSize(9).font('Helvetica');
          doc.fillColor(C.green).text(par.entrada, startX, py, { width: entW, align: 'right', lineBreak: false });

          // Desenhar seta vetorial (→) em vez de caractere Unicode
          const arrowCenterX = startX + entW + arrW / 2;
          const arrowY = py + 4.5;
          doc.save();
          doc.lineWidth(1).strokeColor(C.grayLight).fillColor(C.grayLight);
          // Linha horizontal
          doc.moveTo(arrowCenterX - 7, arrowY).lineTo(arrowCenterX + 5, arrowY).stroke();
          // Ponta da seta (triângulo)
          doc.moveTo(arrowCenterX + 5, arrowY - 3)
            .lineTo(arrowCenterX + 9, arrowY)
            .lineTo(arrowCenterX + 5, arrowY + 3)
            .fill();
          doc.restore();

          doc.fontSize(9).font('Helvetica');
          doc.fillColor(C.red).text(par.saida || '--:--', startX + entW + arrW, py, { width: saiW, align: 'left', lineBreak: false });
          if (durStr) {
            doc.fillColor(C.grayLight).fontSize(7).text(durStr, startX + entW + arrW + saiW, py + 1, { width: durW, align: 'left', lineBreak: false });
          }

          py += 16;
        }
      } else {
        doc.fontSize(9).font('Helvetica').fillColor(C.grayLight);
        doc.text('Sem registros', c1x, y + (ROW_H / 2) - 5, { width: c1w, align: 'center', lineBreak: false });
      }

      // ── Col 2: Horas Trabalhadas (badge outline) ──
      const c2x = TX + colW[0] + colW[1];
      const badgeY = y + (ROW_H / 2) - 8;
      drawBadge(doc, c2x, colW[2], badgeY, minutosParaHoras(dia.trabalhado), '#f9fafb', C.grayBorder, C.black);

      // ── Col 3: Horas Esperadas (badge outline) ──
      const c3x = c2x + colW[2];
      drawBadge(doc, c3x, colW[3], badgeY, minutosParaHoras(dia.esperado), C.white, C.grayBorder, C.black);

      // ── Col 4: Saldo (badge colorido) ──
      const c4x = c3x + colW[3];
      const saldoStr = `${dia.saldo >= 0 ? '+' : ''}${minutosParaHoras(dia.saldo)}`;
      const sBg = dia.saldo >= 0 ? C.greenBg : C.redBg;
      const sFg = dia.saldo >= 0 ? C.greenText : C.redText;
      const sBorder = dia.saldo >= 0 ? '#bbf7d0' : '#fecaca';
      drawBadge(doc, c4x, colW[4], badgeY, saldoStr, sBg, sBorder, sFg);

      y += ROW_H;
    }

    // ────────── TFOOT (Total da Semana) ──────────
    const fH = 28;
    // Borda preta grossa ao redor
    doc.lineWidth(2).strokeColor(C.black);
    doc.rect(TX, y, TW, fH).stroke();

    // Célula "Total da Semana" (branca, colunas 0+1)
    const labelW = colW[0] + colW[1];
    doc.rect(TX + 1, y + 1, labelW - 1, fH - 2).fill(C.white);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Total da Semana', TX + 8, y + 8, { width: labelW - 16, lineBreak: false });

    // Células teal (colunas 2+3+4)
    const tealX = TX + labelW;
    const tealW = colW[2] + colW[3] + colW[4];
    doc.rect(tealX, y + 1, tealW - 1, fH - 2).fill(C.tealDark);

    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.white);
    doc.text(minutosParaHoras(report.totalTrabalhado), tealX, y + 8, { width: colW[2], align: 'center', lineBreak: false });
    doc.text(minutosParaHoras(report.totalEsperado), tealX + colW[2], y + 8, { width: colW[3], align: 'center', lineBreak: false });
    const saldoTxt = `${report.totalSaldo >= 0 ? '+' : ''}${minutosParaHoras(report.totalSaldo)}`;
    doc.text(saldoTxt, tealX + colW[2] + colW[3], y + 8, { width: colW[4], align: 'center', lineBreak: false });

    y += fH;

    // ────────── SALDO TOTAL ACUMULADO (se disponível) ──────────
    if (report.saldoAcumuladoTotal !== undefined) {
      const stH = 26;
      if (y + stH > doc.page.height - 130) {
        doc.addPage();
        y = M;
      }

      // Fundo cinza claro
      doc.rect(TX, y, TW, stH).fill('#f3f4f6');
      doc.lineWidth(1).strokeColor(C.grayBorder);
      doc.rect(TX, y, TW, stH).stroke();

      // Label
      doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
      doc.text('Saldo Total Acumulado', TX + 8, y + 7, { width: labelW - 16, lineBreak: false });

      // Valor colorido
      const stVal = report.saldoAcumuladoTotal;
      const stTxt = `${stVal >= 0 ? '+' : ''}${minutosParaHoras(stVal)}`;
      const stColor = stVal >= 0 ? C.greenText : C.redText;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(stColor);
      doc.text(stTxt, TX + labelW, y + 6, { width: tealW, align: 'center', lineBreak: false });

      y += stH;
    }

    // ────────── ASSINATURAS ──────────
    y += 45;
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = 50;
    }

    const sigW = PW * 0.40;
    const sigL = TX + 15;
    const sigR = TX + PW - sigW - 15;

    doc.lineWidth(1).strokeColor(C.black);

    // Funcionário
    doc.moveTo(sigL, y).lineTo(sigL + sigW, y).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    doc.text(report.nome, sigL, y + 4, { width: sigW, lineBreak: false });
    const hoje = new Date();
    const dataSig = formatInTimeZone(hoje, TZ, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR });
    const dataSigCap = dataSig.charAt(0).toUpperCase() + dataSig.slice(1);
    doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
    doc.text(dataSigCap, sigL, y + 17, { width: sigW, lineBreak: false });

    // CEO
    doc.moveTo(sigR, y).lineTo(sigR + sigW, y).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.black);
    doc.text('Ana Maria Cardoso de Oliveira', sigR, y + 4, { width: sigW, lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(C.grayText);
    doc.text(dataSigCap, sigR, y + 17, { width: sigW, lineBreak: false });

    // ────────── RODAPÉ ──────────
    y += 38;
    const geradoEm = formatInTimeZone(hoje, TZ, 'dd/MM/yyyy HH:mm');
    doc.fontSize(7).font('Helvetica').fillColor(C.grayLight);
    doc.text(`Documento gerado em ${geradoEm} - Vitall Check-Up`, TX, y, { width: PW, align: 'center' });

    doc.end();
  });
}

/** Desenha um badge (pill) com borda, fundo e texto centralizado na célula */
function drawBadge(
  doc: PDFKit.PDFDocument,
  cellX: number,
  cellW: number,
  badgeY: number,
  text: string,
  bgColor: string,
  borderColor: string,
  textColor: string,
): void {
  const bw = 56;
  const bh = 16;
  const bx = cellX + (cellW - bw) / 2;
  const br = 4; // border-radius

  doc.save();
  doc.roundedRect(bx, badgeY, bw, bh, br).lineWidth(0.8).fillAndStroke(bgColor, borderColor);
  doc.fontSize(8).font('Helvetica-Bold').fillColor(textColor);
  doc.text(text, bx, badgeY + 3.5, { width: bw, align: 'center', lineBreak: false });
  doc.restore();
}

// ── Saldo Total Acumulado ──

/** Calcula saldo total acumulado: snapshot + soma dos saldos diários desde data_referencia até upToDateISO */
async function calcSaldoTotal(func: Funcionario, upToDateISO: string): Promise<number | null> {
  if (!func.saldo_data_referencia) return null;

  const snapshot = func.saldo_acumulado_minutos || 0;
  const refDate = func.saldo_data_referencia; // YYYY-MM-DD

  // Buscar registros do período
  const registros = await fetchRegistros(
    `${refDate}T00:00:00-03:00`,
    `${upToDateISO}T23:59:59-03:00`,
  );
  const funcRegs = registros.filter((r) => r.funcionario_id === func.id);

  // Agrupar registros por data BRT
  const byDate = new Map<string, RegistroPonto[]>();
  for (const r of funcRegs) {
    const d = parseISO(r.data_hora);
    if (isNaN(d.getTime())) continue;
    const key = formatInTimeZone(d, TZ, 'yyyy-MM-dd');
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r);
  }

  // Buscar ausências do período
  const ausencias = await getAusenciasByPeriod(func.id, refDate, upToDateISO);
  const ausenciaMap = new Map<string, Ausencia>();
  for (const a of ausencias) {
    ausenciaMap.set(a.data, a);
  }

  // Iterar dia a dia
  let totalSaldo = 0;
  const cursor = new Date(refDate + 'T12:00:00Z');
  const endDate = new Date(upToDateISO + 'T12:00:00Z');

  while (cursor <= endDate) {
    const iso = isoDate(cursor);
    const dow = cursor.getUTCDay();
    let esperado = horasEsperadasDia(dow);

    const ausencia = ausenciaMap.get(iso);
    if (ausencia && (ausencia.tipo === 'feriado' || ausencia.tipo === 'ferias' || ausencia.tipo === 'atestado')) {
      esperado = 0;
    }

    // Calcular trabalhado
    const recs = byDate.get(iso) || [];
    recs.sort((a, b) => new Date(a.data_hora).getTime() - new Date(b.data_hora).getTime());
    let trabalhado = 0;
    for (let i = 0; i < recs.length; i += 2) {
      const ent = recs[i];
      const sai = i + 1 < recs.length ? recs[i + 1] : null;
      if (ent && sai) {
        trabalhado += Math.max(0, differenceInMinutes(parseISO(sai.data_hora), parseISO(ent.data_hora)));
      }
    }

    totalSaldo += trabalhado - esperado;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return snapshot + totalSaldo;
}

/** Atualiza snapshot de saldo acumulado de um funcionário */
async function updateSaldoSnapshot(
  funcionarioId: string,
  saldoMinutos: number,
  dataReferencia: string,
): Promise<boolean> {
  const supabase: any = getSupabasePonto();
  const { error } = await supabase
    .from('funcionarios')
    .update({ saldo_acumulado_minutos: saldoMinutos, saldo_data_referencia: dataReferencia })
    .eq('id', funcionarioId);
  if (error) {
    console.error('[PontoReport] Erro ao atualizar saldo snapshot:', error.message);
    return false;
  }
  return true;
}

// ── Public API ──

export interface PontoReportResult {
  buffer: Buffer;
  fileName: string;
  funcionarioNome: string;
}

/** Busca funcionário por nome parcial (case-insensitive) */
export async function findFuncionarioByName(name: string): Promise<Funcionario | null> {
  const funcionarios = await fetchFuncionarios();
  const search = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return funcionarios.find((f) => {
    const norm = f.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return norm.includes(search);
  }) || null;
}

/** Busca registros de ponto de um funcionário em uma data (YYYY-MM-DD) */
export async function getRegistrosByDate(funcionarioId: string, date: string): Promise<RegistroPonto[]> {
  const startISO = `${date}T00:00:00-03:00`;
  const endISO = `${date}T23:59:59-03:00`;
  const { data, error } = await getSupabasePonto()
    .from('registros_ponto')
    .select('id, funcionario_id, nome_funcionario, data_hora, tipo')
    .eq('funcionario_id', funcionarioId)
    .gte('data_hora', startISO)
    .lte('data_hora', endISO)
    .order('data_hora', { ascending: true });
  if (error) {
    console.error('[PontoReport] Erro ao buscar registros por data:', error.message);
    return [];
  }
  return data || [];
}

/** Adiciona um registro de ponto */
export async function addRegistroPonto(
  funcionarioId: string,
  nomeFuncionario: string,
  dataHora: string,
  tipo: string,
): Promise<{ id: string } | null> {
  const { data, error } = await getSupabasePonto()
    .from('registros_ponto')
    .insert({ funcionario_id: funcionarioId, nome_funcionario: nomeFuncionario, data_hora: dataHora, tipo } as any)
    .select('id')
    .single();
  if (error) {
    console.error('[PontoReport] Erro ao inserir registro:', error.message);
    return null;
  }
  return data;
}

/** Remove um registro de ponto pelo ID */
export async function deleteRegistroPonto(recordId: string): Promise<boolean> {
  const { error } = await getSupabasePonto()
    .from('registros_ponto')
    .delete()
    .eq('id', recordId);
  if (error) {
    console.error('[PontoReport] Erro ao remover registro:', error.message);
    return false;
  }
  return true;
}

/** Calcula período da semana para uma data específica (Seg-Dom que contém a data) */
function calcWeekPeriodForDate(dateStr: string): { start: Date; end: Date } {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start, end };
}

/** Gera PDF de relatório de ponto para um funcionário na semana que contém weekDate (ou semana anterior por padrão) */
export async function generateSingleReport(funcionarioId: string, weekDate?: string): Promise<PontoReportResult | null> {
  const { start, end } = weekDate ? calcWeekPeriodForDate(weekDate) : calcWeekPeriod();

  const funcionarios = await fetchFuncionarios();
  const func = funcionarios.find((f) => f.id === funcionarioId);
  if (!func) return null;

  const registros = await fetchRegistros(
    `${isoDate(start)}T00:00:00-03:00`,
    `${isoDate(end)}T23:59:59-03:00`,
  );

  const report = buildEmployeeReport(func, registros, start, end);

  // Calcular saldo total acumulado (snapshot + período desde referência)
  const saldoTotal = await calcSaldoTotal(func, isoDate(end));
  report.saldoAcumuladoTotal = saldoTotal ?? undefined;

  const buffer = await generateEmployeePDF(report, start, end);

  const parts = func.nome.trim().split(/\s+/);
  const nomeArq = parts.length > 1 ? `${parts[0]}_${parts[parts.length - 1]}` : parts[0];
  const fileName = `${nomeArq}_${fmtDateBR(start).replace(/\//g, '-')}_a_${fmtDateBR(end).replace(/\//g, '-')}.pdf`;

  return { buffer, fileName, funcionarioNome: func.nome };
}

// ── Ausências ──

export interface Ausencia {
  id: string;
  funcionario_id: string;
  data: string;          // YYYY-MM-DD
  tipo: 'feriado' | 'ferias' | 'atestado' | 'falta';
  observacao?: string;
  created_at?: string;
}

/** Busca ausências de um funcionário num período */
export async function getAusenciasByPeriod(
  funcionarioId: string,
  startDate: string,
  endDate: string,
): Promise<Ausencia[]> {
  const { data, error } = await getSupabasePonto()
    .from('ausencias')
    .select('*')
    .eq('funcionario_id', funcionarioId)
    .gte('data', startDate)
    .lte('data', endDate)
    .order('data', { ascending: true });
  if (error) {
    console.error('[PontoReport] Erro ao buscar ausências:', error.message);
    return [];
  }
  return data || [];
}

/** Upsert de ausência (UNIQUE por funcionario+data) */
export async function setAusencia(
  funcionarioId: string,
  data: string,
  tipo: 'feriado' | 'ferias' | 'atestado' | 'falta',
  observacao?: string,
): Promise<{ id: string } | null> {
  const { data: result, error } = await getSupabasePonto()
    .from('ausencias')
    .upsert(
      { funcionario_id: funcionarioId, data, tipo, observacao: observacao || null } as any,
      { onConflict: 'funcionario_id,data' },
    )
    .select('id')
    .single();
  if (error) {
    console.error('[PontoReport] Erro ao inserir/atualizar ausência:', error.message);
    return null;
  }
  return result;
}

/** Remove ausência de um funcionário em uma data */
export async function deleteAusencia(
  funcionarioId: string,
  data: string,
): Promise<boolean> {
  const { error } = await getSupabasePonto()
    .from('ausencias')
    .delete()
    .eq('funcionario_id', funcionarioId)
    .eq('data', data);
  if (error) {
    console.error('[PontoReport] Erro ao remover ausência:', error.message);
    return false;
  }
  return true;
}

// ── Helpers exportados para ai-tools ──

export { fmtHour, minutosParaHoras, horasEsperadasDia, calcSaldoTotal, updateSaldoSnapshot };

export async function generatePontoReports(): Promise<PontoReportResult[]> {
  const { start, end } = calcWeekPeriod();
  console.log(`[PontoReport] Gerando relatórios: ${isoDate(start)} a ${isoDate(end)}`);

  const [funcionarios, registros] = await Promise.all([
    fetchFuncionarios(),
    fetchRegistros(`${isoDate(start)}T00:00:00-03:00`, `${isoDate(end)}T23:59:59-03:00`),
  ]);

  console.log(`[PontoReport] ${funcionarios.length} funcionário(s), ${registros.length} registro(s)`);

  const results: PontoReportResult[] = [];
  for (const func of funcionarios) {
    const report = buildEmployeeReport(func, registros, start, end);
    const buffer = await generateEmployeePDF(report, start, end);

    const parts = func.nome.trim().split(/\s+/);
    const nomeArq = parts.length > 1
      ? `${parts[0]}_${parts[parts.length - 1]}`
      : parts[0];
    const fileName = `${nomeArq}_${fmtDateBR(start).replace(/\//g, '-')}_a_${fmtDateBR(end).replace(/\//g, '-')}.pdf`;

    console.log(`[PontoReport] PDF: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
    results.push({ buffer, fileName, funcionarioNome: func.nome });
  }

  return results;
}
