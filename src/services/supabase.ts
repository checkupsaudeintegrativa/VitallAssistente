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

/** Cria um lembrete para a Jéssica */
export async function createReminder(title: string, remindAt: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('jessica_reminders')
    .insert({ title, remind_at: remindAt })
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
  { id: string; title: string; remind_at: string }[]
> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('jessica_reminders')
    .select('id, title, remind_at')
    .eq('status', 'pending')
    .lte('remind_at', now);

  if (error) {
    console.error('[Supabase] Erro ao buscar lembretes vencidos:', error.message);
    return [];
  }

  return data || [];
}

/** Marca lembrete como enviado */
export async function markReminderSent(reminderId: string): Promise<void> {
  const { error } = await supabase
    .from('jessica_reminders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', reminderId);

  if (error) {
    console.error('[Supabase] Erro ao marcar lembrete como enviado:', error.message);
  }
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

export { supabase };
