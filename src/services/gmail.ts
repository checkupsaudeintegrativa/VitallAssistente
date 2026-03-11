import { google } from 'googleapis';
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

  const nextDay = new Date(Number(year), Number(month) - 1, Number(day) + 1);
  const beforeDate = `${nextDay.getFullYear()}/${String(nextDay.getMonth() + 1).padStart(2, '0')}/${String(nextDay.getDate()).padStart(2, '0')}`;

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

/** Converte string BRL "1.234,56" para número 1234.56 */
function parseBRL(value: string): number {
  const cleaned = value.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}
