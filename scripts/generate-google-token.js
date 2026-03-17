/**
 * Script para gerar refresh token do Google Calendar/Gmail.
 *
 * Uso:
 *   node scripts/generate-google-token.js
 *
 * Pré-requisitos:
 *   - Ter GOOGLE_CALENDAR_CLIENT_ID e GOOGLE_CALENDAR_CLIENT_SECRET no .env
 *   - O app no Google Cloud Console deve estar em "In production"
 */

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');
let open;
try { open = require('open').default || require('open'); } catch { open = null; }

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3456/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Falta GOOGLE_CALENDAR_CLIENT_ID ou GOOGLE_CALENDAR_CLIENT_SECRET no .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
});

// Servidor temporário para receber o callback
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) return;

  const url = new URL(req.url, 'http://localhost:3456');
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('Erro: sem código de autorização');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <h1>✅ Token gerado com sucesso!</h1>
      <p>Copie o refresh_token abaixo e atualize no Render:</p>
      <pre style="background:#f0f0f0;padding:16px;font-size:16px;word-break:break-all">${tokens.refresh_token}</pre>
      <p>Pode fechar esta aba.</p>
    `);

    console.log('\n✅ Token gerado com sucesso!\n');
    console.log('GOOGLE_CALENDAR_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\n→ Atualize essa variável no Render e reinicie o container.\n');

    server.close();
    process.exit(0);
  } catch (err) {
    res.end('Erro ao trocar código: ' + err.message);
    console.error('Erro:', err.message);
  }
});

server.listen(3456, () => {
  console.log('\n🔑 Abrindo navegador para autorizar Google Calendar...\n');
  console.log('Se não abrir automaticamente, acesse:\n' + authUrl + '\n');

  // Tenta abrir o navegador
  if (open) {
    try { open(authUrl); } catch {}
  }
});
