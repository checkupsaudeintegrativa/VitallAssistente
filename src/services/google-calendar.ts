import { google, calendar_v3 } from 'googleapis';
import { env } from '../config/env';

// ── OAuth2 client (reutiliza mesma lógica do Gmail) ──

let calendarClient: calendar_v3.Calendar | null = null;

function getCalendar(): calendar_v3.Calendar | null {
  if (calendarClient) return calendarClient;

  const { GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN } = env;

  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET || !GOOGLE_CALENDAR_REFRESH_TOKEN) {
    console.warn('[GoogleCalendar] Credenciais não configuradas — funcionalidade desabilitada');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET,
  );

  oauth2.setCredentials({ refresh_token: GOOGLE_CALENDAR_REFRESH_TOKEN });

  calendarClient = google.calendar({ version: 'v3', auth: oauth2 });
  console.log('[GoogleCalendar] Cliente inicializado com sucesso');
  return calendarClient;
}

/** Verifica se o Google Calendar está configurado e funcional */
export function isAvailable(): boolean {
  return getCalendar() !== null;
}

// ── Criar evento ──

interface CreateEventParams {
  title: string;
  datetime: string;       // ISO 8601 (ex: "2025-01-15T14:00:00-03:00")
  recurring?: boolean;    // true = repete diariamente
  description?: string;
}

export async function createEvent(params: CreateEventParams): Promise<{ id: string; htmlLink: string } | null> {
  const cal = getCalendar();
  if (!cal) return null;

  const start = new Date(params.datetime);
  const end = new Date(start.getTime() + 30 * 60 * 1000); // 30 minutos de duração

  const event: calendar_v3.Schema$Event = {
    summary: `🔔 ${params.title}`,
    description: params.description || 'Lembrete criado via Vitall Assistente',
    start: {
      dateTime: start.toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 0 },    // Na hora do evento
        { method: 'popup', minutes: 10 },   // 10 min antes
      ],
    },
  };

  // Recorrente = repete diariamente até ser cancelado
  if (params.recurring) {
    event.recurrence = ['RRULE:FREQ=DAILY'];
  }

  try {
    const res = await cal.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    console.log(`[GoogleCalendar] Evento criado: ${res.data.id} — "${params.title}"`);
    return {
      id: res.data.id!,
      htmlLink: res.data.htmlLink || '',
    };
  } catch (error: any) {
    console.error('[GoogleCalendar] Erro ao criar evento:', error.message);
    return null;
  }
}

// ── Listar eventos (lembretes pendentes) ──

interface CalendarReminder {
  id: string;
  title: string;
  datetime: string;
  recurring: boolean;
  created_at: string;
}

export async function listUpcomingEvents(daysAhead: number = 30): Promise<CalendarReminder[]> {
  const cal = getCalendar();
  if (!cal) return [];

  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: '🔔',  // Filtra apenas eventos criados pelo Vitall (têm o emoji 🔔)
    });

    const events = res.data.items || [];

    return events.map((e) => ({
      id: e.id || '',
      title: (e.summary || '').replace('🔔 ', ''),
      datetime: e.start?.dateTime || e.start?.date || '',
      recurring: !!(e.recurringEventId || (e.recurrence && e.recurrence.length > 0)),
      created_at: e.created || '',
    }));
  } catch (error: any) {
    console.error('[GoogleCalendar] Erro ao listar eventos:', error.message);
    return [];
  }
}

// ── Deletar evento ──

export async function deleteEvent(eventId: string): Promise<boolean> {
  const cal = getCalendar();
  if (!cal) return false;

  try {
    await cal.events.delete({
      calendarId: 'primary',
      eventId,
    });
    console.log(`[GoogleCalendar] Evento deletado: ${eventId}`);
    return true;
  } catch (error: any) {
    console.error('[GoogleCalendar] Erro ao deletar evento:', error.message);
    return false;
  }
}
