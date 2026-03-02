import express from 'express';
import cron from 'node-cron';
import { env } from './config/env';
import webhookHandler from './webhooks/handler';
import { getDueReminders, markReminderSent } from './services/supabase';
import { sendText } from './services/evolution';

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

// Webhook routes (chatbot IA)
app.use(webhookHandler);

// Start server
const PORT = parseInt(env.PORT, 10);
app.listen(PORT, () => {
  console.log(`[VitallAssistente] Rodando na porta ${PORT}`);

  // Cron: Lembretes da Jéssica — a cada 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      const due = await getDueReminders();
      if (due.length === 0) return;

      console.log(`[Cron] ${due.length} lembrete(s) da Jéssica vencido(s)`);

      for (const reminder of due) {
        const text = `*Lembrete:* ${reminder.title}`;
        await sendText(env.JESSICA_PHONE, text);
        await markReminderSent(reminder.id);
        console.log(`[Cron] Lembrete enviado: "${reminder.title}"`);
      }
    } catch (error: any) {
      console.error('[Cron] Erro ao processar lembretes:', error.message);
    }
  });

  console.log('[VitallAssistente] IA Assistente iniciada com sucesso!');
  console.log('[VitallAssistente] Webhook: POST /webhook/evolution');
  console.log('[VitallAssistente] Cron: Lembretes Jéssica a cada 5 min');
});
