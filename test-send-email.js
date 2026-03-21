/**
 * Envia um email de teste para verificar se o envio via Gmail está funcionando.
 * Rode: node test-send-email.js
 */

require('dotenv').config();

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🔄 Compilando TypeScript...');
  try {
    execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  } catch (e) {
    console.error('❌ Falha na compilação.');
    process.exit(1);
  }

  const gmail = require('./dist/services/gmail');

  const accountantEmail = process.env.ACCOUNTANT_EMAIL || 'arthurgabriel.birer@gmail.com';
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const yearMonth = '2026-02';
  const ccPath = path.join(__dirname, `pdf-preview/preview-conta-corrente-${yearMonth}.pdf`);
  const cpPath = path.join(__dirname, `pdf-preview/preview-contas-a-pagar-${yearMonth}.pdf`);

  console.log(`\n📧 Destinatário: ${accountantEmail}`);
  console.log('📤 Enviando...\n');

  // Carrega os PDFs já gerados
  if (!fs.existsSync(ccPath) || !fs.existsSync(cpPath)) {
    console.error('❌ PDFs não encontrados. Rode primeiro: node test-pdf-preview.js');
    process.exit(1);
  }

  const ccPDF = fs.readFileSync(ccPath);
  const cpPDF = fs.readFileSync(cpPath);
  const ccSize = (ccPDF.length / 1024).toFixed(1);
  const cpSize = (cpPDF.length / 1024).toFixed(1);
  console.log(`📄 Conta Corrente: ${ccSize} KB`);
  console.log(`📄 Contas a Pagar: ${cpSize} KB\n`);

  const monthTitle = 'Fevereiro de 2026';
  // Link placeholder para o teste (sem Drive real)
  const drivePlaceholder = 'https://drive.google.com';

  const sent = await gmail.sendEmail(
    accountantEmail,
    `Relatórios Financeiros - ${monthTitle} - Vitall Odontologia`,
    `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
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
          <a href="${drivePlaceholder}" style="display:block;padding:14px 20px;background:#277d7e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;text-align:center;">
            📊 Conta Corrente — ${monthTitle}
          </a>
        </div>
        <div>
          <a href="${drivePlaceholder}" style="display:block;padding:14px 20px;background:#277d7e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;text-align:center;">
            📋 Contas a Pagar — ${monthTitle}
          </a>
        </div>
      </div>

      <div style="text-align:center;padding:18px;background:#f0fffe;border:2px dashed #277d7e;border-radius:8px;">
        <p style="margin:0 0 10px;color:#555;font-size:13px;">Acesse todos os arquivos na pasta do Google Drive:</p>
        <a href="${drivePlaceholder}" style="display:inline-block;padding:10px 24px;background:#ffffff;color:#277d7e;text-decoration:none;border:2px solid #277d7e;border-radius:6px;font-weight:600;font-size:14px;">
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
      { filename: `Conta Corrente - ${monthTitle}.pdf`, content: ccPDF, contentType: 'application/pdf' },
      { filename: `Contas a Pagar - ${monthTitle}.pdf`, content: cpPDF, contentType: 'application/pdf' },
    ]
  );

  if (sent) {
    console.log(`✅ Email enviado com sucesso para: ${accountantEmail}`);
    console.log('   Verifique sua caixa de entrada (e pasta spam).');
  } else {
    console.error('❌ Email NÃO enviado.');
    console.error('   Causa provável: escopo gmail.send ausente no GMAIL_REFRESH_TOKEN.');
    console.error('   Solução: regenere o token incluindo https://mail.google.com/ no OAuth consent.');
  }
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
