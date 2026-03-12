import cron from 'node-cron';
import { env } from '../config/env';
import {
  getDueReminders,
  markReminderSent,
  rescheduleReminder,
  getPendingPhotoReminders,
  updatePhotoReminderNext,
  getPendingConsentTerms,
  updateConsentReminderNext,
  createConsentTerm,
  getConsentTermsForDate,
} from '../services/supabase';
import { listAppointments } from '../services/clinicorp';
import { sendText, sendMedia } from '../services/evolution';
import { USER_BY_PHONE } from '../config/users';
import * as gcal from '../services/google-calendar';
import * as gmail from '../services/gmail';
import { generatePontoReports } from '../services/ponto-report';
import { executeTool } from '../services/ai-tools';

// ── Procedimentos que exigem termo de consentimento ──
const CONSENT_KEYWORDS = [
  'cirurgia', 'implante', 'extração', 'extracao', 'siso', 'enxerto', 'exodontia',
  'botox', 'harmonização', 'harmonizacao', 'preenchimento',
  'aparelho', 'instalação de aparelho',
  'sedação', 'sedacao',
];

function requiresConsent(procedureText: string): string | null {
  const lower = procedureText.toLowerCase();
  for (const kw of CONSENT_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

// ── Anti-duplicata in-memory para lembretes do Google Calendar ──
const calendarSentMap = new Map<string, number>();

function cleanSentMap(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, ts] of calendarSentMap) {
    if (ts < oneHourAgo) calendarSentMap.delete(key);
  }
}

export function startScheduler(): void {
  // Lembretes — a cada 5 min (envia para quem pediu, suporta recorrência)
  cron.schedule('*/5 * * * *', async () => {
    try {
      const due = await getDueReminders();
      if (due.length === 0) return;

      console.log(`[Cron] ${due.length} lembrete(s) vencido(s)`);

      for (const reminder of due) {
        const targetPhone = reminder.phone || env.JESSICA_PHONE;
        const count = (reminder.reminder_count || 0) + 1;
        const suffix = count > 1 ? ` _(lembrete #${count})_` : '';

        const text = `*Lembrete:* ${reminder.title}${suffix}`;
        await sendText(targetPhone, text);

        if (reminder.recurring) {
          const nextMorning = new Date();
          nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
          nextMorning.setUTCHours(10, 30, 0, 0);
          await rescheduleReminder(reminder.id, nextMorning.toISOString(), count);
          console.log(`[Cron] Lembrete recorrente enviado para ${targetPhone}: "${reminder.title}" (count: ${count})`);
        } else {
          await markReminderSent(reminder.id);
          console.log(`[Cron] Lembrete único enviado para ${targetPhone}: "${reminder.title}"`);
        }
      }
    } catch (error: any) {
      console.error('[Cron] Erro ao processar lembretes:', error.message);
    }
  });

  // Lembretes de foto de paciente — a cada 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      const pending = await getPendingPhotoReminders();
      if (pending.length === 0) return;

      console.log(`[Cron] ${pending.length} lembrete(s) de foto pendente(s)`);

      for (const reminder of pending) {
        const patientInfo = reminder.patient_name ? ` de *${reminder.patient_name}*` : '';
        const text = `⚠️ *Lembrete — Foto de paciente*\n\nVocê enviou uma foto${patientInfo} mas ainda não confirmou que adicionou na ficha do Clinicorp.\n\nJá adicionou? Responde "sim" ou "feito" para eu parar de lembrar 😊`;
        await sendText(env.JESSICA_PHONE, text);

        const nextMorning = new Date();
        nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
        nextMorning.setUTCHours(11, 0, 0, 0);
        await updatePhotoReminderNext(reminder.id, nextMorning.toISOString(), reminder.reminder_count + 1);

        console.log(`[Cron] Lembrete de foto enviado (count: ${reminder.reminder_count + 1})`);
      }
    } catch (error: any) {
      console.error('[Cron] Erro ao processar lembretes de foto:', error.message);
    }
  });

  // Alerta de termos de consentimento — 08:00 UTC (05:00 BRT), diário, seg-sáb
  cron.schedule('0 8 * * 1-6', async () => {
    try {
      console.log('[Cron] Verificando termos de consentimento do dia');

      const today = new Date().toISOString().split('T')[0];
      const raw = await listAppointments(today, today);
      const appointments = Array.isArray(raw) ? raw : [];

      const existingTerms = await getConsentTermsForDate(today);
      const existingPatients = new Set(existingTerms.map((t) => t.patient_name.toLowerCase()));

      const alertMessages: string[] = [];

      for (const a of appointments) {
        if (a.Deleted === 'X') continue;

        const proc = (a.Procedures || '') + ' ' + (a.Notes || '');
        const matchedKw = requiresConsent(proc);
        if (!matchedKw) continue;

        const patientName = a.PatientName || 'Paciente sem nome';
        if (existingPatients.has(patientName.toLowerCase())) continue;

        await createConsentTerm(patientName, matchedKw, today);
        alertMessages.push(`• *${patientName}* — ${proc.substring(0, 80)}`);
      }

      if (alertMessages.length > 0) {
        const text = `⚠️ *Termos de consentimento pendentes hoje*\n\nOs seguintes pacientes têm procedimentos que exigem termo assinado:\n\n${alertMessages.join('\n')}\n\nQuando receber o termo escaneado, me envia o PDF para eu registrar ✅`;
        await sendText(env.JESSICA_PHONE, text);
        console.log(`[Cron] Alertou ${alertMessages.length} termos de consentimento pendentes`);
      } else {
        console.log('[Cron] Nenhum termo de consentimento pendente hoje');
      }
    } catch (error: any) {
      console.error('[Cron] Erro ao verificar termos de consentimento:', error.message);
    }
  });

  // Follow-up de termos de consentimento — a cada 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      const pending = await getPendingConsentTerms();
      if (pending.length === 0) return;

      console.log(`[Cron] ${pending.length} termo(s) de consentimento pendente(s) para follow-up`);

      for (const term of pending) {
        const text = `⚠️ *Lembrete — Termo de consentimento*\n\n*${term.patient_name}* tem procedimento de *${term.procedure_type}* agendado para ${term.appointment_date} e o termo de consentimento ainda não foi recebido.\n\nJá coletou a assinatura? Me envia o PDF escaneado 📋`;
        await sendText(env.JESSICA_PHONE, text);

        const nextMorning = new Date();
        nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
        nextMorning.setUTCHours(11, 0, 0, 0);
        await updateConsentReminderNext(term.id, nextMorning.toISOString(), term.reminder_count + 1);

        console.log(`[Cron] Follow-up de termo enviado para ${term.patient_name} (count: ${term.reminder_count + 1})`);
      }
    } catch (error: any) {
      console.error('[Cron] Erro ao processar follow-up de termos:', error.message);
    }
  });

  // Lembretes do Google Calendar — a cada 2 min (consulta eventos nos próximos 5 min)
  cron.schedule('*/2 * * * *', async () => {
    try {
      cleanSentMap();

      const users = Array.from(USER_BY_PHONE.values());
      const seen = new Set<string>();
      const uniqueUsers = users.filter((u) => {
        if (seen.has(u.name)) return false;
        seen.add(u.name);
        return true;
      });

      for (const user of uniqueUsers) {
        const calConfig = user.features.googleCalendar;
        if (!calConfig) continue;

        // Calendário principal do user
        const events = await gcal.getDueEvents(calConfig);
        for (const event of events) {
          if (calendarSentMap.has(event.id)) continue;

          await sendText(user.phones[0], `*Lembrete:* ${event.title}`);
          calendarSentMap.set(event.id, Date.now());
          console.log(`[Cron:Calendar] Lembrete enviado para ${user.name}: "${event.title}"`);

          // Único → marca ✅ automaticamente (não aparece no digest)
          // Recorrente → mantém 🔔 (digest às 7h30/17h vai lembrar de novo)
          if (!event.recurring) {
            await gcal.markEventDone(calConfig, event.id);
          }
        }

        // Cross-calendars com notificação (ex: Dra. Ana recebe lembretes da Jéssica)
        if (calConfig.crossCalendars) {
          for (const cross of calConfig.crossCalendars.filter((c) => c.notify)) {
            const crossConfig = { account: calConfig.account, calendarId: cross.calendarId };
            const crossEvents = await gcal.getDueEvents(crossConfig);

            for (const event of crossEvents) {
              const crossKey = `${event.id}:cross:${user.name}`;
              if (calendarSentMap.has(crossKey)) continue;

              await sendText(user.phones[0], `*Lembrete (${cross.name}):* ${event.title}`);
              calendarSentMap.set(crossKey, Date.now());
              console.log(`[Cron:Calendar] Lembrete cross (${cross.name}) enviado para ${user.name}: "${event.title}"`);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('[Cron:Calendar] Erro ao processar lembretes do Calendar:', error.message);
    }
  });

  // Digest de lembretes pendentes — 7h30 BRT (10:30 UTC) e 17h BRT (20:00 UTC)
  async function sendPendingDigest(): Promise<void> {
    const users = Array.from(USER_BY_PHONE.values());
    const seen = new Set<string>();
    const uniqueUsers = users.filter((u) => {
      if (seen.has(u.name)) return false;
      seen.add(u.name);
      return true;
    });

    for (const user of uniqueUsers) {
      const calConfig = user.features.googleCalendar;
      if (!calConfig) continue;

      try {
        const pending = await gcal.listPendingReminders(calConfig);
        // Só inclui lembretes recorrentes (tarefas pendentes)
        const tasks = pending.filter((e) => e.recurring);
        if (tasks.length === 0) continue;

        const lines = tasks.map((t, i) => `${i + 1}. ${t.title}`);
        const separator = '\n─────────\n';
        const header = tasks.length === 1 ? '⏰ *Lembrete pendente:*' : '⏰ *Lembretes pendentes:*';
        const text = `${header}\n\n${lines.join(separator)}`;

        await sendText(user.phones[0], text);
        console.log(`[Cron:Digest] ${tasks.length} lembrete(s) pendente(s) enviado(s) para ${user.name}`);
      } catch (error: any) {
        console.error(`[Cron:Digest] Erro ao enviar digest para ${user.name}:`, error.message);
      }
    }
  }

  cron.schedule('30 10 * * *', async () => {
    console.log('[Cron:Digest] Digest 7h30 BRT');
    await sendPendingDigest();
  });

  cron.schedule('0 20 * * *', async () => {
    console.log('[Cron:Digest] Digest 17h BRT');
    await sendPendingDigest();
  });

  // Relatório de ponto semanal — toda segunda-feira 08:00 BRT (11:00 UTC)
  cron.schedule('0 11 * * 1', async () => {
    try {
      console.log('[Cron:Ponto] Gerando relatórios de ponto semanal...');

      const reports = await generatePontoReports();
      const phones = ['5511934550921', '5511944655555']; // Jéssica, Dra. Ana

      for (const report of reports) {
        const base64 = report.buffer.toString('base64');
        const caption = `Ponto Semanal — ${report.funcionarioNome}`;

        for (const phone of phones) {
          const ok = await sendMedia(phone, base64, report.fileName, caption);
          console.log(`[Cron:Ponto] ${report.funcionarioNome} → ${phone}: ${ok ? 'OK' : 'FALHOU'}`);
        }
      }

      console.log(`[Cron:Ponto] ${reports.length} relatório(s) enviado(s) com sucesso`);
    } catch (error: any) {
      console.error('[Cron:Ponto] Erro ao gerar/enviar relatórios:', error.message);
    }
  });

  // Auto-importação de saídas bancárias C6 Bank — a cada 2 min, 24/7
  if (gmail.isAvailable()) {
    cron.schedule('*/2 * * * *', async () => {
      try {
        const today = new Date();
        const brtDate = new Date(today.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const dateStr = brtDate.toISOString().split('T')[0];

        // Usa executeTool como admin para processar
        const result = await executeTool('sync_bank_transactions', { date: dateStr }, { name: 'Sistema', role: 'admin', phones: [], features: {} } as any);
        const parsed = JSON.parse(result);

        if (parsed.sincronizadas > 0) {
          console.log(`[Cron:Banco] ${parsed.sincronizadas} saída(s) importada(s) do C6 Bank (R$ ${parsed.valor_total.toFixed(2)})`);
        } else if (parsed.error) {
          console.error(`[Cron:Banco] Erro: ${parsed.mensagem || parsed.error}`);
        }
        // Se ja_existentes > 0 e sincronizadas === 0, não loga nada (normal)
      } catch (error: any) {
        console.error('[Cron:Banco] Erro ao importar transações bancárias:', error.message);
      }
    });

    console.log('  - */2 * * * *: Auto-importação C6 Bank saídas (a cada 2 min, 24/7)');

    // Auto-importação de ENTRADAS bancárias C6 Bank — a cada 2 min, 24/7
    cron.schedule('*/2 * * * *', async () => {
      try {
        const today = new Date();
        const brtDate = new Date(today.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const dateStr = brtDate.toISOString().split('T')[0];

        const result = await executeTool('sync_bank_entradas', { date: dateStr }, { name: 'Sistema', role: 'admin', phones: [], features: {} } as any);
        const parsed = JSON.parse(result);

        if (parsed.sincronizadas > 0) {
          console.log(`[Cron:Banco] ${parsed.sincronizadas} entrada(s) importada(s) do C6 Bank (R$ ${parsed.valor_total.toFixed(2)})`);
        } else if (parsed.error) {
          console.error(`[Cron:Banco] Erro entradas: ${parsed.mensagem || parsed.error}`);
        }
      } catch (error: any) {
        console.error('[Cron:Banco] Erro ao importar entradas bancárias:', error.message);
      }
    });

    console.log('  - */2 * * * *: Auto-importação C6 Bank entradas (a cada 2 min, 24/7)');
  }

  // Auto-importação de vendas Clinicorp — a cada 2 min, 24/7
  cron.schedule('*/2 * * * *', async () => {
    try {
      const today = new Date();
      const brtDate = new Date(today.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const dateStr = brtDate.toISOString().split('T')[0];

      const result = await executeTool('sync_clinicorp_payments', { date: dateStr }, { name: 'Sistema', role: 'admin', phones: [], features: {} } as any);
      const parsed = JSON.parse(result);

      if (parsed.sincronizadas > 0) {
        console.log(`[Cron:Clinicorp] ${parsed.sincronizadas} venda(s) importada(s) do Clinicorp (R$ ${parsed.valor_total.toFixed(2)})`);
      } else if (parsed.error) {
        console.error(`[Cron:Clinicorp] Erro: ${parsed.mensagem || parsed.error}`);
      }
    } catch (error: any) {
      console.error('[Cron:Clinicorp] Erro ao importar vendas do Clinicorp:', error.message);
    }
  });

  console.log('[Cron] Scheduler de lembretes iniciado:');
  console.log('  - */5 * * * *: Lembretes pessoais (a cada 5 min)');
  console.log('  - */5 * * * *: Lembretes de foto de paciente (a cada 5 min)');
  console.log('  - 08:00 UTC (05:00 BRT): Alerta termos de consentimento (seg-sáb)');
  console.log('  - */5 * * * *: Follow-up termos de consentimento (a cada 5 min)');
  console.log('  - */2 * * * *: Lembretes do Google Calendar (a cada 2 min)');
  console.log('  - 10:30/20:00 UTC (7h30/17h BRT): Digest de lembretes pendentes');
  console.log('  - 11:00 UTC (08:00 BRT): Relatório de ponto semanal (segunda-feira)');
  console.log('  - */2 * * * *: Auto-importação vendas Clinicorp (a cada 2 min, 24/7)');
}
