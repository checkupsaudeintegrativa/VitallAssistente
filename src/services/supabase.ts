import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

const supabase: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// ── Chatbot AI (chat_messages) ──

/** Salva uma mensagem do chatbot (user ou assistant) */
export async function saveChatMessage(
  phone: string,
  role: 'user' | 'assistant',
  content: string,
  mediaType?: 'text' | 'image' | 'audio' | 'document'
): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    phone,
    role,
    content,
    media_type: mediaType || 'text',
  });

  if (error) {
    console.error('[Supabase] Erro ao salvar chat message:', error.message);
  }
}

/** Busca últimas N mensagens do chatbot para um telefone (para contexto) */
export async function getChatHistory(
  phone: string,
  limit: number = 30
): Promise<{ role: string; content: string; created_at: string }[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Supabase] Erro ao buscar chat history:', error.message);
    return [];
  }

  // Retorna em ordem cronológica (mais antiga primeiro)
  return (data || []).reverse();
}

// ── Dentist Info ──

/** Busca o número de WhatsApp e nome de um dentista pelo PersonId */
export async function getDentistInfo(personId: number): Promise<{ phone: string; name: string } | null> {
  const { data, error } = await supabase
    .from('dentist_phones')
    .select('whatsapp_number, dentist_name')
    .eq('clinicorp_person_id', personId)
    .eq('active', true)
    .limit(1);

  if (error) {
    console.error(`[Supabase] Erro getDentistInfo(${personId}):`, error.message);
    return null;
  }

  if (data && data.length > 0) {
    return { phone: data[0].whatsapp_number, name: data[0].dentist_name };
  }
  console.warn(`[Supabase] Dentista não encontrado para personId: ${personId}`);
  return null;
}

// ── Jessica Reminders ──

/** Cria um lembrete (envia para o phone que pediu, suporta recorrência) */
export async function createReminder(
  title: string,
  remindAt: string,
  phone?: string,
  recurring?: boolean
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('jessica_reminders')
    .insert({
      title,
      remind_at: remindAt,
      phone: phone || null,
      recurring: recurring || false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] Erro ao criar lembrete:', error.message);
    return null;
  }

  return data;
}

/** Lista lembretes pendentes da Jéssica */
export async function listPendingReminders(): Promise<
  { id: string; title: string; remind_at: string; created_at: string }[]
> {
  const { data, error } = await supabase
    .from('jessica_reminders')
    .select('id, title, remind_at, created_at')
    .eq('status', 'pending')
    .order('remind_at', { ascending: true });

  if (error) {
    console.error('[Supabase] Erro ao listar lembretes:', error.message);
    return [];
  }

  return data || [];
}

/** Busca lembretes vencidos (remind_at <= now) que ainda estão pendentes */
export async function getDueReminders(): Promise<
  { id: string; title: string; remind_at: string; phone: string | null; recurring: boolean; reminder_count: number }[]
> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('jessica_reminders')
    .select('id, title, remind_at, phone, recurring, reminder_count')
    .eq('status', 'pending')
    .lte('remind_at', now);

  if (error) {
    console.error('[Supabase] Erro ao buscar lembretes vencidos:', error.message);
    return [];
  }

  return data || [];
}

/** Marca lembrete como enviado (não-recorrente) */
export async function markReminderSent(reminderId: string): Promise<void> {
  const { error } = await supabase
    .from('jessica_reminders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', reminderId);

  if (error) {
    console.error('[Supabase] Erro ao marcar lembrete como enviado:', error.message);
  }
}

/** Para recorrente: incrementa contador e agenda próximo (mantém pending) */
export async function rescheduleReminder(reminderId: string, nextAt: string, count: number): Promise<void> {
  const { error } = await supabase
    .from('jessica_reminders')
    .update({ remind_at: nextAt, reminder_count: count, sent_at: new Date().toISOString() })
    .eq('id', reminderId);

  if (error) {
    console.error('[Supabase] Erro ao reagendar lembrete:', error.message);
  }
}

/** Confirma lembrete recorrente como feito (para de lembrar) */
export async function confirmReminderDone(reminderId: string): Promise<boolean> {
  const { error } = await supabase
    .from('jessica_reminders')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', reminderId)
    .in('status', ['pending', 'sent']);

  if (error) {
    console.error('[Supabase] Erro ao confirmar lembrete:', error.message);
    return false;
  }
  return true;
}

/** Cancela um lembrete */
export async function cancelReminder(reminderId: string): Promise<boolean> {
  const { error } = await supabase
    .from('jessica_reminders')
    .update({ status: 'cancelled' })
    .eq('id', reminderId)
    .eq('status', 'pending');

  if (error) {
    console.error('[Supabase] Erro ao cancelar lembrete:', error.message);
    return false;
  }

  return true;
}

// ── Image Storage ──

/** Upload de imagem base64 para Supabase Storage — retorna URL pública */
export async function uploadImageToStorage(
  base64: string,
  mimetype: string,
  folder: string = 'patient-photos'
): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimetype.includes('png') ? 'png' : mimetype.includes('webp') ? 'webp' : 'jpg';
    const fileName = `${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

    const { error } = await supabase.storage
      .from('uploads')
      .upload(fileName, buffer, {
        contentType: mimetype,
        upsert: false,
      });

    if (error) {
      console.error('[Supabase Storage] Erro no upload:', error.message);
      return null;
    }

    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
    return urlData?.publicUrl || null;
  } catch (error: any) {
    console.error('[Supabase Storage] Erro:', error.message);
    return null;
  }
}

// ── Patient Photo Reminders ──

/** Cria lembrete de foto de paciente (next_reminder = 3h depois) */
export async function createPhotoReminder(
  description: string,
  patientName: string | null
): Promise<{ id: string } | null> {
  const nextReminder = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('patient_photo_reminders')
    .insert({
      description,
      patient_name: patientName,
      next_reminder_at: nextReminder,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] Erro ao criar photo reminder:', error.message);
    return null;
  }
  return data;
}

/** Marca foto como confirmada */
export async function confirmPhotoAdded(reminderId: string): Promise<boolean> {
  const { error } = await supabase
    .from('patient_photo_reminders')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', reminderId)
    .eq('status', 'pending');

  if (error) {
    console.error('[Supabase] Erro ao confirmar photo:', error.message);
    return false;
  }
  return true;
}

// ── Consent Terms ──

/** Cria termo de consentimento pendente */
export async function createConsentTerm(
  patientName: string,
  procedureType: string,
  appointmentDate: string
): Promise<{ id: string } | null> {
  const nextReminder = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('consent_terms')
    .insert({
      patient_name: patientName,
      procedure_type: procedureType,
      appointment_date: appointmentDate,
      next_reminder_at: nextReminder,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] Erro ao criar consent term:', error.message);
    return null;
  }
  return data;
}

/** Marca termo como recebido */
export async function markTermReceived(termId: string): Promise<boolean> {
  const { error } = await supabase
    .from('consent_terms')
    .update({ status: 'received', received_at: new Date().toISOString() })
    .eq('id', termId)
    .eq('status', 'pending');

  if (error) {
    console.error('[Supabase] Erro ao marcar termo recebido:', error.message);
    return false;
  }
  return true;
}

/** Busca termo de consentimento por paciente e data */
export async function findConsentByPatientAndDate(
  patientName: string,
  date: string
): Promise<{ id: string; status: string } | null> {
  const search = patientName.toLowerCase();
  const { data, error } = await supabase
    .from('consent_terms')
    .select('id, status')
    .ilike('patient_name', `%${search}%`)
    .eq('appointment_date', date)
    .limit(1);

  if (error) {
    console.error('[Supabase] Erro ao buscar consent by patient/date:', error.message);
    return null;
  }
  return data && data.length > 0 ? data[0] : null;
}

// ── Cron helpers (lembretes, fotos, termos) ──

/** Busca lembretes de foto pendentes e vencidos */
export async function getPendingPhotoReminders(): Promise<
  { id: string; description: string; patient_name: string; reminder_count: number }[]
> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('patient_photo_reminders')
    .select('id, description, patient_name, reminder_count')
    .eq('status', 'pending')
    .lte('next_reminder_at', now);

  if (error) {
    console.error('[Supabase] Erro ao buscar photo reminders:', error.message);
    return [];
  }
  return data || [];
}

/** Atualiza próximo lembrete de foto */
export async function updatePhotoReminderNext(
  reminderId: string,
  nextAt: string,
  count: number
): Promise<void> {
  const { error } = await supabase
    .from('patient_photo_reminders')
    .update({ next_reminder_at: nextAt, reminder_count: count })
    .eq('id', reminderId);

  if (error) {
    console.error('[Supabase] Erro ao atualizar photo reminder:', error.message);
  }
}

/** Busca termos de consentimento pendentes e vencidos */
export async function getPendingConsentTerms(): Promise<
  { id: string; patient_name: string; procedure_type: string; appointment_date: string; reminder_count: number }[]
> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('consent_terms')
    .select('id, patient_name, procedure_type, appointment_date, reminder_count')
    .eq('status', 'pending')
    .lte('next_reminder_at', now);

  if (error) {
    console.error('[Supabase] Erro ao buscar consent terms:', error.message);
    return [];
  }
  return data || [];
}

/** Busca termos de consentimento para uma data (para cron não duplicar) */
export async function getConsentTermsForDate(
  date: string
): Promise<{ id: string; patient_name: string; procedure_type: string; status: string }[]> {
  const { data, error } = await supabase
    .from('consent_terms')
    .select('id, patient_name, procedure_type, status')
    .eq('appointment_date', date);

  if (error) {
    console.error('[Supabase] Erro ao buscar consent terms for date:', error.message);
    return [];
  }
  return data || [];
}

/** Atualiza próximo lembrete de termo */
export async function updateConsentReminderNext(
  termId: string,
  nextAt: string,
  count: number
): Promise<void> {
  const { error } = await supabase
    .from('consent_terms')
    .update({ next_reminder_at: nextAt, reminder_count: count })
    .eq('id', termId);

  if (error) {
    console.error('[Supabase] Erro ao atualizar consent reminder:', error.message);
  }
}

export { supabase };
