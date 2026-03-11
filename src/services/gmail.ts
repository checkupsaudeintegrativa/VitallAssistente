import { google } from 'googleapis';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { env } from '../config/env';

// Lazy init — só cria o client se as env vars estiverem preenchidas
let gmailClient: ReturnType<typeof google.gmail> | null = null;

function getGmailClient() {
  if (gmailClient) return gmailClient;

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail env vars não configuradas (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  }

  const oauth2Client = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailClient;
}

/** Retorna true se as 3 env vars do Gmail estão preenchidas */
export function isAvailable(): boolean {
  return !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

export interface BankTransaction {
  amount: number;
  type: 'entrada' | 'saida';
  description: string;
  recipient: string;
  emailSubject: string;
  emailMessageId: string;
  rawBody: string;
}

/**
 * Busca emails do C6 Bank (no-reply@c6bank.com.br) para uma data específica.
 * Retorna TODAS as transações (entradas e saídas).
 */
export async function fetchC6BankTransactions(dateStr: string): Promise<BankTransaction[]> {
  const gmail = getGmailClient();

  const [year, month, day] = dateStr.split('-');
  const afterDate = `${year}/${month}/${day}`;

  // +2 dias no "before" para cobrir fuso BRT (UTC-3):
  // emails das 21h-23h59 BRT caem no dia seguinte em UTC
  const afterDay = new Date(Number(year), Number(month) - 1, Number(day) + 2);
  const beforeDate = `${afterDay.getFullYear()}/${String(afterDay.getMonth() + 1).padStart(2, '0')}/${String(afterDay.getDate()).padStart(2, '0')}`;

  const query = `from:no-reply@c6bank.com.br after:${afterDate} before:${beforeDate}`;
  console.log(`[Gmail] Buscando emails C6 Bank: ${query}`);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 100,
  });

  const messages = listRes.data.messages || [];
  console.log(`[Gmail] ${messages.length} email(s) encontrado(s)`);

  const transactions: BankTransaction[] = [];

  for (const msg of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      });

      const headers = detail.data.payload?.headers || [];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '';
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '';
      const messageId = msg.id!;

      const body = extractBody(detail.data.payload);
      if (!body) continue;

      const parsed = parseC6BankEmail(body, subject, from);
      if (parsed) {
        // Filtra pela data real da transação (corpo do email tem "em DD/MM/YYYY")
        // Necessário porque a query Gmail usa +1 dia de margem para cobrir fuso BRT
        const expectedDate = `${day}/${month}/${year}`;
        const hasDate = body.includes(expectedDate);
        if (!hasDate) {
          // Fallback: emails de recebíveis dizem "Hoje" em vez da data explícita.
          // Usa o header Date do email (convertido para BRT) como referência.
          const dateHeader = headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';
          const emailDateBRT = parseEmailDateToBRT(dateHeader);
          if (emailDateBRT !== dateStr) {
            console.log(`[Gmail] Email ignorado (data diferente de ${expectedDate}): ${subject}`);
            continue;
          }
          console.log(`[Gmail] Email aceito via fallback header Date (${emailDateBRT}): ${subject}`);
        }

        transactions.push({
          ...parsed,
          recipient: extractRecipient(body),
          emailSubject: subject,
          emailMessageId: messageId,
          rawBody: body.substring(0, 2000),
        });
      }
    } catch (err: any) {
      console.warn(`[Gmail] Erro ao processar email ${msg.id}:`, err.message);
    }
  }

  const entradas = transactions.filter((t) => t.type === 'entrada').length;
  const saidas = transactions.filter((t) => t.type === 'saida').length;
  console.log(`[Gmail] ${transactions.length} transação(ões): ${entradas} entradas, ${saidas} saídas`);
  return transactions;
}

/** Extrai o body do email (suporta plain text e HTML multipart) */
function extractBody(payload: any): string | null {
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  if (payload.parts) {
    const plainPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plainPart?.body?.data) {
      return decodeBase64Url(plainPart.body.data);
    }

    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return stripHtml(decodeBase64Url(htmlPart.body.data));
    }

    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return null;
}

/** Decodifica base64url (formato do Gmail) */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Remove tags HTML — otimizado para emails C6 Bank (HTML pesado com style/head) */
function stripHtml(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#?\w+;/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Classifica e extrai transação de um email do C6 Bank.
 * Detecta o tipo pelo campo "From" do C6: "C6 Empresas: Pix recebido", "C6 Empresas: Pix enviado", etc.
 */
function parseC6BankEmail(
  body: string,
  subject: string,
  from: string,
): { amount: number; type: 'entrada' | 'saida'; description: string } | null {
  const fullText = `${from}\n${subject}\n${body}`.toLowerCase();

  // Keywords que indicam SAÍDA (dinheiro saiu da conta)
  // NÃO incluir "débito/debito" — é ambíguo (recebimento via cartão de débito ≠ saída)
  const saidaKeywords = ['pix enviado', 'enviado no valor', 'pagamento realizado', 'saque', 'tarifa', 'taxa'];
  // Keywords que indicam ENTRADA (dinheiro entrou na conta)
  const entradaKeywords = ['recebid', 'recebimentos agendados', 'depósito', 'deposito', 'crédito', 'credito', 'pix recebido'];

  const isSaida = saidaKeywords.some((kw) => fullText.includes(kw));
  const isEntrada = entradaKeywords.some((kw) => fullText.includes(kw));

  if (!isSaida && !isEntrada) {
    console.log(`[Gmail] Email ignorado (não é transação): ${subject}`);
    return null;
  }

  // Entrada tem prioridade — se ambos matcham, é entrada (ex: "recebimento via débito")
  const type = isEntrada ? 'entrada' : 'saida';

  const amountRegex = /R\$\s*([\d.,]+)/g;
  const searchText = `${body}\n${subject}`;
  const match = amountRegex.exec(searchText);

  if (!match) {
    console.log(`[Gmail] Email sem valor monetário: ${from}`);
    return null;
  }

  const amount = parseBRL(match[1]);
  if (amount <= 0) return null;

  const description = body.substring(0, 300).replace(/\s+/g, ' ').trim();

  console.log(`[Gmail] ${type.toUpperCase()}: R$ ${amount.toFixed(2)} — ${from}`);
  return { amount, type, description };
}

/**
 * Extrai o nome do destinatário do corpo do email C6 Bank.
 * Ex: "Pix enviado no valor de R$ 350,00, para Marcela Marques Sobral, CPF..." → "Marcela Marques Sobral"
 * Ex: "Pix enviado no valor de R$ 335,00, para RADIOLOGIC RADIOLOGIA..., CNPJ..." → "RADIOLOGIC RADIOLOGIA..."
 */
function extractRecipient(body: string): string {
  // Padrão saída: "para NOME, CPF/CNPJ..."
  const paraMatch = body.match(/para\s+([^,]+),\s*(?:CPF|CNPJ)/i);
  if (paraMatch) return paraMatch[1].trim();

  // Padrão entrada: "de NOME, CPF/CNPJ..." ou "por NOME"
  const deMatch = body.match(/(?:de|por)\s+([^,]+),\s*(?:CPF|CNPJ)/i);
  if (deMatch) return deMatch[1].trim();

  return '';
}

/**
 * Converte o header Date do email (RFC 2822) para YYYY-MM-DD em BRT (UTC-3).
 * Ex: "Mon, 2 Mar 2026 06:15:00 +0000" → "2026-03-02"
 */
function parseEmailDateToBRT(dateHeader: string): string {
  try {
    const d = new Date(dateHeader);
    if (isNaN(d.getTime())) return '';
    // Converte para BRT (UTC-3)
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const y = brt.getUTCFullYear();
    const m = String(brt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(brt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  } catch {
    return '';
  }
}

/** Converte string BRL "1.234,56" para número 1234.56 */
function parseBRL(value: string): number {
  const cleaned = value.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ── Extração de recebíveis do Excel anexo do C6 Bank ──

export interface RecebívelParcela {
  bandeira: string;
  tipo: string; // "Crédito" | "Débito"
  parcela: string; // "1/2", "2/2", "1/1"
  valorBruto: number;
  taxa: number;
  valorLiquido: number;
  nsu: string;
}

const C6_EXCEL_PASSWORD = '591389';

/**
 * Busca o email de recebíveis do C6 Bank para uma data, baixa o Excel anexo,
 * decripta e retorna as parcelas individuais.
 */
export async function fetchRecebiveis(dateStr: string): Promise<RecebívelParcela[]> {
  const gmail = getGmailClient();
  const [year, month, day] = dateStr.split('-');

  // O arquivo "Recebiveis-Detalhado-C6Pay-YYYY-MM-DD.xlsx" vem no email do dia anterior ou mesmo dia
  const afterDay = new Date(Number(year), Number(month) - 1, Number(day) - 1);
  const beforeDay = new Date(Number(year), Number(month) - 1, Number(day) + 2);
  const afterDate = `${afterDay.getFullYear()}/${String(afterDay.getMonth() + 1).padStart(2, '0')}/${String(afterDay.getDate()).padStart(2, '0')}`;
  const beforeDate = `${beforeDay.getFullYear()}/${String(beforeDay.getMonth() + 1).padStart(2, '0')}/${String(beforeDay.getDate()).padStart(2, '0')}`;

  const query = `from:no-reply@c6bank.com.br after:${afterDate} before:${beforeDate} subject:resumo`;
  console.log(`[Gmail] Buscando recebíveis Excel: ${query}`);

  const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 });
  const messages = listRes.data.messages || [];

  const targetFilename = `Recebiveis-Detalhado-C6Pay-${dateStr}.xlsx`;

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'full' });
    const parts = detail.data.payload?.parts || [];

    for (const part of parts) {
      if (!part.filename || !part.body?.attachmentId) continue;
      if (part.filename !== targetFilename) continue;

      console.log(`[Gmail] Encontrado anexo: ${part.filename}`);

      const attach = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: msg.id!,
        id: part.body.attachmentId,
      });

      const data = attach.data.data || '';
      const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

      return decryptAndParseExcel(buffer);
    }
  }

  console.log(`[Gmail] Anexo ${targetFilename} não encontrado`);
  return [];
}

function decryptAndParseExcel(buffer: Buffer): RecebívelParcela[] {
  const encPath = join(tmpdir(), `c6_enc_${Date.now()}.xls`);
  const decPath = join(tmpdir(), `c6_dec_${Date.now()}.xls`);

  try {
    writeFileSync(encPath, buffer);
    execSync(`python -m msoffcrypto -p ${C6_EXCEL_PASSWORD} "${encPath}" "${decPath}"`, { stdio: 'pipe' });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const XLSX = require('xlsx');
    const decBuffer = readFileSync(decPath);
    const workbook = XLSX.read(decBuffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const parcelas: RecebívelParcela[] = [];
    for (const row of rows) {
      if (!row || row.length < 12) continue;
      // Linhas de subtotal têm "-" nas colunas de detalhe — pular
      if (row[5] === '-' || row[5] === undefined) continue;
      // Linha de transação real: col 5 = "Venda"
      if (String(row[5]).toLowerCase() !== 'venda') continue;

      const parcela: RecebívelParcela = {
        bandeira: String(row[0] || ''),
        tipo: String(row[1] || ''),
        parcela: String(row[8] || '1/1'),
        valorBruto: Math.abs(Number(row[9]) || 0),
        taxa: Number(row[10]) || 0,
        valorLiquido: Math.abs(Number(row[11]) || 0),
        nsu: String(row[6] || ''),
      };

      if (parcela.valorBruto > 0) {
        parcelas.push(parcela);
      }
    }

    console.log(`[Gmail] Excel decriptado: ${parcelas.length} parcela(s) de recebíveis`);
    return parcelas;
  } catch (err: any) {
    console.warn(`[Gmail] Erro ao decriptar/parsear Excel: ${err.message}`);
    return [];
  } finally {
    try { unlinkSync(encPath); } catch {}
    try { unlinkSync(decPath); } catch {}
  }
}
