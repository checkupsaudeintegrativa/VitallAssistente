import express from 'express';
import { env } from './config/env';
import webhookHandler from './webhooks/handler';
import { startScheduler } from './cron/scheduler';
import * as gcal from './services/google-calendar';

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'VitallAssistente',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Teste Google Calendar
app.get('/test/calendar', async (req, res) => {
  try {
    const account = (req.query.account as 'personal' | 'clinic') || 'personal';
    const calendarId = (req.query.calendarId as string) || 'primary';
    const config = { account, calendarId };

    const available = gcal.isAvailable(config);
    if (!available) {
      return res.json({
        status: 'error',
        message: `Google Calendar NÃO configurado para conta "${account}"`,
        env_check: {
          client_id: !!env.GOOGLE_CALENDAR_CLIENT_ID,
          client_secret: !!env.GOOGLE_CALENDAR_CLIENT_SECRET,
          personal_token: !!env.GOOGLE_CALENDAR_REFRESH_TOKEN,
          clinic_token: !!env.GOOGLE_CALENDAR_CLINIC_REFRESH_TOKEN,
        },
      });
    }

    const start = new Date(Date.now() + 60 * 60 * 1000);
    const event = await gcal.createEvent(config, {
      title: 'Teste Vitall - pode deletar',
      datetime: start.toISOString(),
    });

    res.json({
      status: 'ok',
      message: `Google Calendar funcionando! (conta: ${account}, calendar: ${calendarId})`,
      event,
    });
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Webhook routes (chatbot IA)
app.use(webhookHandler);

// Start server
const PORT = parseInt(env.PORT, 10);
app.listen(PORT, () => {
  console.log(`[VitallAssistente] Rodando na porta ${PORT}`);
  console.log('[VitallAssistente] IA Assistente iniciada com sucesso!');
  console.log('[VitallAssistente] Webhook: POST /webhook/evolution');

  // Iniciar crons de lembretes
  startScheduler();
});
