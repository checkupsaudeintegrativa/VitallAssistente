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
import { sendText } from '../services/evolution';

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

  console.log('[Cron] Scheduler de lembretes iniciado:');
  console.log('  - */5 * * * *: Lembretes pessoais (a cada 5 min)');
  console.log('  - */5 * * * *: Lembretes de foto de paciente (a cada 5 min)');
  console.log('  - 08:00 UTC (05:00 BRT): Alerta termos de consentimento (seg-sáb)');
  console.log('  - */5 * * * *: Follow-up termos de consentimento (a cada 5 min)');
}
