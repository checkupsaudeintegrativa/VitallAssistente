import { google, calendar_v3 } from 'googleapis';
import { env } from '../config/env';
import { GoogleCalendarConfig, GoogleCalendarAccount } from '../config/users';

// ── Multi-account OAuth2 clients ──

const calendarClients = new Map<GoogleCalendarAccount, calendar_v3.Calendar>();

function getCalendarClient(account: GoogleCalendarAccount): calendar_v3.Calendar | null {
  if (calendarClients.has(account)) return calendarClients.get(account)!;

  const { GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET } = env;
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET) {
    console.warn(`[GoogleCalendar] CLIENT_ID/SECRET não configurados — conta "${account}" desabilitada`);
    return null;
  }

  const refreshToken =
    account === 'personal'
      ? env.GOOGLE_CALENDAR_REFRESH_TOKEN
      : env.GOOGLE_CALENDAR_CLINIC_REFRESH_TOKEN;

  if (!refreshToken) {
    console.warn(`[GoogleCalendar] Refresh token não configurado para conta "${account}"`);
    return null;
  }

  const oauth2 = new google.auth.OAuth2(GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const client = google.calendar({ version: 'v3', auth: oauth2 });
  calendarClients.set(account, client);
  console.log(`[GoogleCalendar] Cliente inicializado para conta "${account}"`);
  return client;
}

/** Verifica se o Google Calendar está disponível para uma config específica */
export function isAvailable(config?: GoogleCalendarConfig): boolean {
  if (!config) return false;
  return getCalendarClient(config.account) !== null;
}

// ── Criar evento ──

interface CreateEventParams {
  title: string;
  datetime: string;       // ISO 8601 (ex: "2025-01-15T14:00:00-03:00")
  recurring?: boolean;    // true = repete diariamente
  description?: string;
}

export async function createEvent(config: GoogleCalendarConfig, params: CreateEventParams): Promise<{ id: string; htmlLink: string } | null> {
  const cal = getCalendarClient(config.account);
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

  // Tag no description para identificar tipo (digest cron usa isso)
  if (params.recurring) {
    event.description = '[recorrente] ' + (params.description || 'Lembrete criado via Vitall Assistente');
  }

  try {
    const res = await cal.events.insert({
      calendarId: config.calendarId,
      requestBody: event,
    });

    console.log(`[GoogleCalendar] Evento criado: ${res.data.id} — "${params.title}" (calendar: ${config.calendarId})`);
    return {
      id: res.data.id!,
      htmlLink: res.data.htmlLink || '',
    };
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao criar evento (calendar: ${config.calendarId}):`, error.message);
    return null;
  }
}

// ── Buscar eventos que vencem nos próximos minutos (para cron de lembretes) ──

interface DueEvent {
  id: string;
  title: string;
  datetime: string;
  recurring: boolean;
}

export async function getDueEvents(config: GoogleCalendarConfig, minutesAhead: number = 5): Promise<DueEvent[]> {
  const cal = getCalendarClient(config.account);
  if (!cal) return [];

  const now = new Date();
  const future = new Date(now.getTime() + minutesAhead * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: config.calendarId,
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: '🔔',
    });

    const events = res.data.items || [];

    return events.map((e) => ({
      id: e.id || '',
      title: (e.summary || '').replace('🔔 ', ''),
      datetime: e.start?.dateTime || e.start?.date || '',
      recurring: (e.description || '').includes('[recorrente]'),
    }));
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao buscar eventos due (calendar: ${config.calendarId}):`, error.message);
    return [];
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

export async function listUpcomingEvents(config: GoogleCalendarConfig, daysAhead: number = 30): Promise<CalendarReminder[]> {
  const cal = getCalendarClient(config.account);
  if (!cal) return [];

  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: config.calendarId,
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
      recurring: (e.description || '').includes('[recorrente]'),
      created_at: e.created || '',
    }));
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao listar eventos (calendar: ${config.calendarId}):`, error.message);
    return [];
  }
}

// ── Listar eventos de um dia específico (passados + futuros, 🔔 e ✅) ──

interface CalendarReminderWithStatus extends CalendarReminder {
  done: boolean;
}

export async function listEventsForDate(config: GoogleCalendarConfig, date: string): Promise<CalendarReminderWithStatus[]> {
  const cal = getCalendarClient(config.account);
  if (!cal) return [];

  const startOfDay = new Date(`${date}T00:00:00-03:00`);
  const endOfDay = new Date(`${date}T23:59:59-03:00`);

  try {
    const [pendingRes, doneRes] = await Promise.all([
      cal.events.list({
        calendarId: config.calendarId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        q: '🔔',
      }),
      cal.events.list({
        calendarId: config.calendarId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        q: '✅',
      }),
    ]);

    const pending = (pendingRes.data.items || []).map((e) => ({
      id: e.id || '',
      title: (e.summary || '').replace('🔔 ', ''),
      datetime: e.start?.dateTime || e.start?.date || '',
      recurring: (e.description || '').includes('[recorrente]'),
      created_at: e.created || '',
      done: false,
    }));

    const done = (doneRes.data.items || []).map((e) => ({
      id: e.id || '',
      title: (e.summary || '').replace('✅ ', ''),
      datetime: e.start?.dateTime || e.start?.date || '',
      recurring: (e.description || '').includes('[recorrente]'),
      created_at: e.created || '',
      done: true,
    }));

    return [...pending, ...done].sort(
      (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
    );
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao listar eventos do dia (calendar: ${config.calendarId}):`, error.message);
    return [];
  }
}

// ── Listar lembretes pendentes (🔔 com start time no passado = não feitos) ──

export async function listPendingReminders(config: GoogleCalendarConfig): Promise<CalendarReminder[]> {
  const cal = getCalendarClient(config.account);
  if (!cal) return [];

  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const now = new Date();

  try {
    const res = await cal.events.list({
      calendarId: config.calendarId,
      timeMin: oneYearAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: '🔔',
    });

    const events = res.data.items || [];

    return events.map((e) => ({
      id: e.id || '',
      title: (e.summary || '').replace('🔔 ', ''),
      datetime: e.start?.dateTime || e.start?.date || '',
      recurring: (e.description || '').includes('[recorrente]'),
      created_at: e.created || '',
    }));
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao listar lembretes pendentes (calendar: ${config.calendarId}):`, error.message);
    return [];
  }
}

// ── Marcar evento como feito (🔔 → ✅) ──

export async function markEventDone(config: GoogleCalendarConfig, eventId: string): Promise<boolean> {
  const cal = getCalendarClient(config.account);
  if (!cal) return false;

  try {
    const res = await cal.events.get({ calendarId: config.calendarId, eventId });
    const currentTitle = res.data.summary || '';
    const newTitle = currentTitle.replace('🔔', '✅');

    await cal.events.patch({
      calendarId: config.calendarId,
      eventId,
      requestBody: { summary: newTitle },
    });

    console.log(`[GoogleCalendar] Evento marcado como feito: ${eventId} — "${newTitle}" (calendar: ${config.calendarId})`);
    return true;
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao marcar evento como feito (calendar: ${config.calendarId}):`, error.message);
    return false;
  }
}

// ── Deletar evento ──

export async function deleteEvent(config: GoogleCalendarConfig, eventId: string): Promise<boolean> {
  const cal = getCalendarClient(config.account);
  if (!cal) return false;

  try {
    await cal.events.delete({
      calendarId: config.calendarId,
      eventId,
    });
    console.log(`[GoogleCalendar] Evento deletado: ${eventId} (calendar: ${config.calendarId})`);
    return true;
  } catch (error: any) {
    console.error(`[GoogleCalendar] Erro ao deletar evento (calendar: ${config.calendarId}):`, error.message);
    return false;
  }
}
