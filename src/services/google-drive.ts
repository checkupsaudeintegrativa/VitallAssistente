import { google } from 'googleapis';
import { env } from '../config/env';

// Lazy init — só cria o client se as env vars estiverem preenchidas
let driveClient: ReturnType<typeof google.drive> | null = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET || !env.GOOGLE_DRIVE_CLINIC_REFRESH_TOKEN) {
    throw new Error('Google Drive env vars não configuradas (GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_DRIVE_CLINIC_REFRESH_TOKEN)');
  }

  // Usa a mesma credencial OAuth (CLIENT_ID/SECRET) do Calendar/Gmail
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CALENDAR_CLIENT_ID,
    env.GOOGLE_CALENDAR_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: env.GOOGLE_DRIVE_CLINIC_REFRESH_TOKEN });

  driveClient = google.drive({ version: 'v3', auth: oauth2Client });
  return driveClient;
}

/** Retorna true se as env vars do Google Drive estão preenchidas */
export function isAvailable(): boolean {
  return !!(
    env.GOOGLE_CALENDAR_CLIENT_ID &&
    env.GOOGLE_CALENDAR_CLIENT_SECRET &&
    env.GOOGLE_DRIVE_CLINIC_REFRESH_TOKEN &&
    env.GOOGLE_DRIVE_FOLDER_ID
  );
}

/**
 * Cria ou encontra uma subpasta para o mês (ex: "2026-03") dentro da pasta pai.
 * @param yearMonth - String no formato "YYYY-MM" (ex: "2026-03")
 * @param parentFolderId - ID da pasta pai (GOOGLE_DRIVE_FOLDER_ID)
 * @returns ID da subpasta encontrada ou criada
 */
export async function ensureMonthFolder(yearMonth: string, parentFolderId: string): Promise<string> {
  const drive = getDriveClient();

  // Buscar pasta existente
  const searchRes = await drive.files.list({
    q: `name='${yearMonth}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const existing = searchRes.data.files?.[0];
  if (existing?.id) {
    console.log(`[Drive] Pasta "${yearMonth}" já existe (${existing.id})`);
    return existing.id;
  }

  // Criar pasta nova
  const createRes = await drive.files.create({
    requestBody: {
      name: yearMonth,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name',
  });

  const newId = createRes.data.id!;
  console.log(`[Drive] Pasta "${yearMonth}" criada (${newId})`);
  return newId;
}

/**
 * Faz upload de um PDF no Google Drive.
 * @param fileName - Nome do arquivo (ex: "Conta Corrente - Março 2026.pdf")
 * @param buffer - Buffer com o conteúdo do PDF
 * @param folderId - ID da pasta de destino
 * @returns Objeto com fileId e webViewLink
 */
export async function uploadPDF(
  fileName: string,
  buffer: Buffer,
  folderId: string,
): Promise<{ fileId: string; webViewLink: string }> {
  const drive = getDriveClient();
  const { Readable } = require('stream');

  const media = {
    mimeType: 'application/pdf',
    body: Readable.from(buffer),
  };

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/pdf',
    },
    media,
    fields: 'id, webViewLink',
  });

  const fileId = res.data.id!;
  const webViewLink = res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  console.log(`[Drive] PDF "${fileName}" enviado (${fileId}): ${webViewLink}`);
  return { fileId, webViewLink };
}
