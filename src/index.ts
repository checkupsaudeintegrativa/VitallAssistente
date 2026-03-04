import express from 'express';
import { env } from './config/env';
import webhookHandler from './webhooks/handler';
import { startScheduler } from './cron/scheduler';

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
  console.log('[VitallAssistente] IA Assistente iniciada com sucesso!');
  console.log('[VitallAssistente] Webhook: POST /webhook/evolution');

  // Iniciar crons de lembretes
  startScheduler();
});
