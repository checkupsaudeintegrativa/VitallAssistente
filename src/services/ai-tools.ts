import * as clinicorp from './clinicorp';
import * as db from './supabase';
import * as gcal from './google-calendar';
import { UserConfig, GoogleCalendarConfig } from '../config/users';

// ── Types ──

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** Ferramentas restritas a admin (não disponíveis para staff) */
const FINANCIAL_TOOLS = new Set(['query_payments', 'get_financial_summary']);

// ── Tool Definitions (OpenAI function calling schemas) ──

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Retorna a data e hora atual no fuso horário de São Paulo (BRT). Use sempre que precisar saber "hoje", "agora", "amanhã", dia da semana, etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_appointments',
      description: 'Consulta agendamentos num intervalo de datas. Retorna quantidade e lista resumida. Use para perguntas como "quantos pacientes hoje?", "agenda da semana".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
          dentist_name: { type: 'string', description: 'Nome parcial do dentista para filtrar (opcional). Ex: "Marcela", "Ana", "Pedro"' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agenda_detail',
      description: 'Retorna a agenda detalhada de um dia, com horários e nomes dos pacientes por dentista. Use para "agenda da Dra. Marcela amanhã", "quem atende às 10h?".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          dentist_name: { type: 'string', description: 'Nome parcial do dentista para filtrar (opcional)' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_payments',
      description: 'Consulta pagamentos/parcelas num intervalo de datas. Retorna lista com paciente, valor, status. Use para "pagamentos de hoje", "parcelas vencidas".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_patient_info',
      description: 'Busca informações de um paciente pelo nome (busca nos agendamentos recentes). Retorna nome completo, telefone, último agendamento.',
      parameters: {
        type: 'object',
        properties: {
          search_term: { type: 'string', description: 'Nome ou parte do nome do paciente' },
        },
        required: ['search_term'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_birthdays',
      description: 'Retorna lista de aniversariantes de uma data. Use para "aniversariantes de hoje", "quem faz aniversário amanhã?".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_financial_summary',
      description: 'Retorna resumo financeiro de um período: total recebido, por forma de pagamento. Use para "quanto faturou hoje?", "resumo financeiro da semana".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Cria um lembrete. O lembrete será enviado via WhatsApp no horário especificado para o telefone de quem pediu. Se não tiver horário, calcule: agora + 3h (mas NUNCA depois das 17h30 BRT — se passar, use 17h30 BRT do mesmo dia ou 7h30 BRT do dia seguinte). Se a pessoa não especificar que é único, crie como recorrente (recurring=true) — o sistema vai lembrar todo dia às 7h30 BRT até ela confirmar que fez.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
          datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2025-01-15T14:00:00-03:00". Se não tiver horário, calcule +3h capped 17h30 BRT.' },
          phone: { type: 'string', description: 'Telefone de quem pediu (do contexto [Contexto]). Ex: "5511943635555"' },
          recurring: { type: 'boolean', description: 'true = lembra todo dia até confirmar. false = lembra uma vez só. Default: true para tarefas ("me lembra de..."), false para horários fixos ("me avisa às 14h").' },
        },
        required: ['title', 'datetime', 'phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'Lista todos os lembretes pendentes. Use para "quais meus lembretes?", "tenho lembrete pra hoje?".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Cancela/remove um lembrete pelo ID. Use quando pedir para cancelar ou remover um lembrete.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string', description: 'UUID do lembrete a cancelar' },
        },
        required: ['reminder_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_reminder_done',
      description: 'Confirma que a tarefa do lembrete foi feita — para de lembrar. Use quando a pessoa disser "feito", "já fiz", "pode parar de lembrar", "✅" referindo-se a um lembrete recorrente.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string', description: 'UUID do lembrete a confirmar como feito' },
        },
        required: ['reminder_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_procedures',
      description: 'Consulta agendamentos filtrados por tipo de procedimento. Categorias: "revisao" (revisão, retorno, controle, manutenção), "cirurgia" (cirurgia, extração, implante, enxerto, exodontia), "estetico" (botox, harmonização, clareamento, lente, faceta), "ortodontia" (aparelho, ortodontia, alinhador). Use para "revisões dessa semana", "cirurgias do mês", "quantos pacientes de botox".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
          category: { type: 'string', description: 'Categoria de procedimento: "revisao", "cirurgia", "estetico", "ortodontia". Se omitido, retorna todos.' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_patient_photo',
      description: 'Faz upload da foto do paciente direto para a ficha no Clinicorp. Use quando a imagem enviada for foto de uma pessoa E o nome do paciente for informado. Busca o paciente no Clinicorp e envia a foto automaticamente. Precisa da image_url do [Contexto].',
      parameters: {
        type: 'object',
        properties: {
          patient_name: { type: 'string', description: 'Nome do paciente para buscar no Clinicorp' },
          image_url: { type: 'string', description: 'URL pública da imagem (do [Contexto] / [Imagem])' },
        },
        required: ['patient_name', 'image_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_photo_reminder',
      description: 'Cria um lembrete de foto de paciente caso não consiga fazer upload automático. O sistema lembrará automaticamente até confirmar.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Descrição do que você viu na foto.' },
          patient_name: { type: 'string', description: 'Nome do paciente, se mencionado.' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_photo_added',
      description: 'Confirma que a foto do paciente foi adicionada na ficha do Clinicorp manualmente.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'string', description: 'UUID do lembrete de foto a confirmar' },
        },
        required: ['reminder_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_consent_term',
      description: 'Cria um registro de termo de consentimento pendente. Use quando identificar que um procedimento precisa de termo, ou quando a Jéssica mencionar um termo que precisa ser coletado.',
      parameters: {
        type: 'object',
        properties: {
          patient_name: { type: 'string', description: 'Nome do paciente' },
          procedure_type: { type: 'string', description: 'Tipo do procedimento (ex: "cirurgia", "implante", "botox")' },
          appointment_date: { type: 'string', description: 'Data do agendamento YYYY-MM-DD' },
        },
        required: ['patient_name', 'procedure_type', 'appointment_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_term_received',
      description: 'Confirma que o termo de consentimento foi recebido. Use quando Jéssica enviar um PDF de termo escaneado, ou confirmar que o termo foi coletado.',
      parameters: {
        type: 'object',
        properties: {
          term_id: { type: 'string', description: 'UUID do termo de consentimento (se disponível)' },
          patient_name: { type: 'string', description: 'Nome do paciente (usado para buscar o termo se term_id não for informado)' },
          date: { type: 'string', description: 'Data do agendamento YYYY-MM-DD (usado junto com patient_name para buscar o termo)' },
        },
        required: [],
      },
    },
  },
];

// ── Tool Executors ──

/** Cache de dentistas: PersonId → nome (da tabela dentist_phones no Supabase) */
let dentistNameCache: Map<number, string> | null = null;

/** Carrega mapa de PersonId → nome do dentista (Supabase + Clinicorp) */
async function loadDentistNames(): Promise<Map<number, string>> {
  if (dentistNameCache) return dentistNameCache;
  dentistNameCache = new Map();

  try {
    const users = await clinicorp.listUsers();
    const list = Array.isArray(users) ? users : [];
    for (const u of list) {
      if (u.PersonId && u.Name) {
        dentistNameCache.set(u.PersonId, u.Name);
      }
    }
  } catch (e: any) {
    console.error('[AI-Tools] Erro ao carregar dentistas:', e.message);
  }

  return dentistNameCache;
}

/** Extrai o primeiro nome */
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0];
}

/** Retorna o primeiro nome do dentista pelo PersonId (ex: "Marcela", "Ana") */
async function getDentistName(personId: number): Promise<string> {
  const info = await db.getDentistInfo(personId);
  if (info) return firstName(info.name);

  const cache = await loadDentistNames();
  const fullName = cache.get(personId);
  return fullName ? firstName(fullName) : 'Sem dentista';
}

/** Busca PersonIds que batem com um nome parcial */
async function findDentistPersonIds(dentistName: string): Promise<number[]> {
  const cache = await loadDentistNames();
  const search = dentistName.toLowerCase();
  const ids: number[] = [];
  for (const [id, name] of cache) {
    if (name.toLowerCase().includes(search)) ids.push(id);
  }
  return ids;
}

/** Formata horário "HH:MM" → "HHh" ou "HHhMM" */
function formatTime(time: string): string {
  if (!time) return 'N/A';
  const [h, m] = time.split(':');
  if (!m || m === '00') return `${h}h`;
  return `${h}h${m}`;
}

function getBrtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

/** Resolve qual GoogleCalendarConfig usar. Se targetCalendar for informado, busca em crossCalendars. */
function resolveCalendarConfig(user?: UserConfig | null, targetCalendar?: string): GoogleCalendarConfig | null {
  const calConfig = user?.features?.googleCalendar;
  if (!calConfig) return null;

  if (targetCalendar && calConfig.crossCalendars) {
    const cross = calConfig.crossCalendars.find(
      (c) => c.name.toLowerCase() === targetCalendar.toLowerCase(),
    );
    if (cross) {
      return { account: calConfig.account, calendarId: cross.calendarId };
    }
  }

  return calConfig;
}

/** Retorna toolDefinitions filtradas pelo papel e features do usuário */
export function getToolsForUser(user?: UserConfig | null): ToolDefinition[] {
  let tools = user && user.role !== 'admin'
    ? toolDefinitions.filter((t) => !FINANCIAL_TOOLS.has(t.function.name))
    : [...toolDefinitions];

  const calConfig = user?.features?.googleCalendar;
  const hasCrossCalendars = calConfig?.crossCalendars && calConfig.crossCalendars.length > 0;
  const crossNames = calConfig?.crossCalendars?.map((c) => c.name).join(', ') || '';

  // Se o usuário tem Google Calendar configurado e disponível, adapta as tools de lembrete
  if (calConfig && gcal.isAvailable(calConfig)) {
    // Parâmetro target_calendar para criação (todos os cross calendars)
    const createTargetParam = hasCrossCalendars
      ? { target_calendar: { type: 'string', description: `Calendário alvo. Omita para usar o seu próprio. Valores possíveis: ${crossNames}` } }
      : {};

    // Parâmetro target_calendar para visualização (só cross calendars com canView)
    const viewableCross = calConfig?.crossCalendars?.filter((c) => c.canView) || [];
    const viewNames = viewableCross.map((c) => c.name).join(', ');
    const viewTargetParam = viewableCross.length > 0
      ? { target_calendar: { type: 'string', description: `Calendário alvo. Omita para usar o seu próprio. Valores possíveis: ${viewNames}` } }
      : {};

    tools = tools.map((t) => {
      if (t.function.name === 'create_reminder') {
        return {
          ...t,
          function: {
            ...t.function,
            description: 'Cria um lembrete. NÃO precisa do parâmetro phone. Se não tiver horário, calcule: agora + 3h (mas NUNCA depois das 17h30 BRT). Se a pessoa não especificar que é único, crie como recorrente (recurring=true).',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
                datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2025-01-15T14:00:00-03:00". Se não tiver horário, calcule +3h capped 17h30 BRT.' },
                phone: { type: 'string', description: 'Opcional — ignorado.' },
                recurring: { type: 'boolean', description: 'true = lembra todo dia até confirmar. false = lembra uma vez só. Default: true para tarefas, false para horários fixos.' },
                ...createTargetParam,
              },
              required: ['title', 'datetime'],
            },
          },
        };
      }
      if (t.function.name === 'list_reminders') {
        return {
          ...t,
          function: {
            ...t.function,
            description: 'Lista todos os lembretes pendentes.',
            parameters: {
              type: 'object',
              properties: { ...viewTargetParam },
              required: [],
            },
          },
        };
      }
      if (t.function.name === 'delete_reminder') {
        return {
          ...t,
          function: {
            ...t.function,
            description: 'Remove um lembrete pelo ID.',
            parameters: {
              type: 'object',
              properties: {
                reminder_id: { type: 'string', description: 'ID do lembrete' },
                ...viewTargetParam,
              },
              required: ['reminder_id'],
            },
          },
        };
      }
      if (t.function.name === 'confirm_reminder_done') {
        return {
          ...t,
          function: {
            ...t.function,
            description: 'Confirma que a tarefa foi feita — para de lembrar.',
            parameters: {
              type: 'object',
              properties: {
                reminder_id: { type: 'string', description: 'ID do lembrete' },
                ...viewTargetParam,
              },
              required: ['reminder_id'],
            },
          },
        };
      }
      return t;
    });
  }

  return tools;
}

/** Executa uma ferramenta pelo nome e argumentos, retorna string JSON com resultado */
export async function executeTool(name: string, args: Record<string, any>, user?: UserConfig | null): Promise<string> {
  // Guard: staff não pode usar ferramentas financeiras
  if (user && user.role !== 'admin' && FINANCIAL_TOOLS.has(name)) {
    return JSON.stringify({
      error: 'Sem permissão',
      mensagem: `Você não tem acesso a informações financeiras. Fale com o Arthur ou a Dra. Ana para consultas financeiras.`,
    });
  }

  try {
    switch (name) {
      case 'get_current_datetime':
        return executeGetCurrentDatetime();

      case 'query_appointments':
        return executeQueryAppointments(args.date_from, args.date_to, args.dentist_name);

      case 'get_agenda_detail':
        return executeGetAgendaDetail(args.date, args.dentist_name);

      case 'query_payments':
        return executeQueryPayments(args.date_from, args.date_to);

      case 'get_patient_info':
        return executeGetPatientInfo(args.search_term);

      case 'get_birthdays':
        return executeGetBirthdays(args.date);

      case 'get_financial_summary':
        return executeGetFinancialSummary(args.date_from, args.date_to);

      case 'create_reminder':
        return executeCreateReminder(args.title, args.datetime, args.phone, args.recurring, user, args.target_calendar);

      case 'list_reminders':
        return executeListReminders(user, args.target_calendar);

      case 'delete_reminder':
        return executeDeleteReminder(args.reminder_id, user, args.target_calendar);

      case 'confirm_reminder_done':
        return executeConfirmReminderDone(args.reminder_id, user, args.target_calendar);

      case 'query_procedures':
        return executeQueryProcedures(args.date_from, args.date_to, args.category);

      case 'upload_patient_photo':
        return executeUploadPatientPhoto(args.patient_name, args.image_url);

      case 'create_photo_reminder':
        return executeCreatePhotoReminder(args.description, args.patient_name);

      case 'confirm_photo_added':
        return executeConfirmPhotoAdded(args.reminder_id);

      case 'create_consent_term':
        return executeCreateConsentTerm(args.patient_name, args.procedure_type, args.appointment_date);

      case 'confirm_term_received':
        return executeConfirmTermReceived(args.term_id, args.patient_name, args.date);

      default:
        return JSON.stringify({ error: `Ferramenta desconhecida: ${name}` });
    }
  } catch (error: any) {
    console.error(`[AI-Tools] Erro ao executar ${name}:`, error.message);
    return JSON.stringify({ error: `Erro ao executar ${name}: ${error.message}` });
  }
}

// ── Individual executors ──

function executeGetCurrentDatetime(): string {
  const now = getBrtNow();
  const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  return JSON.stringify({
    date: now.toISOString().split('T')[0],
    time: now.toTimeString().substring(0, 5),
    weekday: weekdays[now.getDay()],
    full: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  });
}

async function executeQueryAppointments(dateFrom: string, dateTo: string, dentistName?: string): Promise<string> {
  const raw = await clinicorp.listAppointments(dateFrom, dateTo);
  let appointments = Array.isArray(raw) ? raw : [];

  appointments = appointments.filter((a: any) => a.Deleted !== 'X');

  if (dentistName) {
    const personIds = await findDentistPersonIds(dentistName);
    if (personIds.length > 0) {
      appointments = appointments.filter((a: any) => {
        const dId = a.Dentist_PersonId || a.CreatedUserId;
        return personIds.includes(dId);
      });
    }
  }

  const summary = [];
  for (const a of appointments) {
    const dentistId = a.Dentist_PersonId || a.CreatedUserId;
    const dentistFullName = dentistId ? await getDentistName(dentistId) : 'Sem dentista';

    summary.push({
      paciente: a.PatientName || 'N/A',
      horario: formatTime(a.fromTime || ''),
      dentista: dentistFullName,
      procedimento: a.Procedures || a.Notes || '',
    });
  }

  return JSON.stringify({
    total: summary.length,
    agendamentos: summary.slice(0, 50),
  });
}

async function executeGetAgendaDetail(date: string, dentistName?: string): Promise<string> {
  const raw = await clinicorp.listAppointments(date, date);
  let appointments = Array.isArray(raw) ? raw : [];

  appointments = appointments.filter((a: any) => a.Deleted !== 'X');

  if (dentistName) {
    const personIds = await findDentistPersonIds(dentistName);
    if (personIds.length > 0) {
      appointments = appointments.filter((a: any) => {
        const dId = a.Dentist_PersonId || a.CreatedUserId;
        return personIds.includes(dId);
      });
    }
  }

  const byDentist: Record<string, any[]> = {};
  for (const a of appointments) {
    const dentistId = a.Dentist_PersonId || a.CreatedUserId;
    const dentistFullName = dentistId ? await getDentistName(dentistId) : 'Sem dentista';

    if (!byDentist[dentistFullName]) byDentist[dentistFullName] = [];
    byDentist[dentistFullName].push({
      horario: formatTime(a.fromTime || ''),
      paciente: a.PatientName || 'N/A',
      procedimento: a.Procedures || a.Notes || '',
    });
  }

  for (const dentist of Object.keys(byDentist)) {
    byDentist[dentist].sort((a, b) => (a.horario || '').localeCompare(b.horario || ''));
  }

  return JSON.stringify({
    data: date,
    total_pacientes: appointments.length,
    agenda_por_dentista: byDentist,
  });
}

async function executeQueryPayments(dateFrom: string, dateTo: string): Promise<string> {
  const raw = await clinicorp.listPayments(dateFrom, dateTo);
  const payments = Array.isArray(raw) ? raw : [];

  let totalValue = 0;
  const summary = payments.map((p: any) => {
    const value = p.Value || p.Amount || 0;
    totalValue += value;
    return {
      paciente: p.PatientName || p.Patient_Name || 'N/A',
      valor: value,
      vencimento: p.DueDate || p.Due_Date || '',
      status: p.Status || '',
      forma_pagamento: p.PaymentMethod || p.Payment_Method || '',
    };
  });

  return JSON.stringify({
    total_parcelas: summary.length,
    valor_total: totalValue,
    parcelas: summary.slice(0, 50),
  });
}

async function executeGetPatientInfo(searchTerm: string): Promise<string> {
  const now = getBrtNow();
  const from = new Date(now);
  from.setDate(from.getDate() - 90);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = now.toISOString().split('T')[0];

  const raw = await clinicorp.listAppointments(fromStr, toStr);
  const appointments = Array.isArray(raw) ? raw : [];

  const search = searchTerm.toLowerCase();
  const matches = appointments.filter((a: any) => {
    const name = (a.PatientName || '').toLowerCase();
    return name.includes(search) && a.Deleted !== 'X';
  });

  const seen = new Set<string>();
  const patients = [];
  for (const a of matches) {
    const name = a.PatientName || 'N/A';
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const dentistId = a.Dentist_PersonId || a.CreatedUserId;
    const dentistFullName = dentistId ? await getDentistName(dentistId) : 'N/A';

    patients.push({
      nome: name,
      telefone: a.MobilePhone || a.Phone || 'N/A',
      ultimo_agendamento: a.date ? a.date.substring(0, 10) : 'N/A',
      horario: formatTime(a.fromTime || ''),
      dentista: dentistFullName,
    });
  }

  return JSON.stringify({
    encontrados: patients.length,
    pacientes: patients.slice(0, 20),
  });
}

async function executeGetBirthdays(date: string): Promise<string> {
  const raw = await clinicorp.getBirthdays(date);
  const birthdays = Array.isArray(raw) ? raw : [];

  const list = birthdays.map((b: any) => ({
    nome: b.PatientName || b.Name || b.Patient_Name || 'N/A',
    telefone: b.CellPhone || b.Phone || b.PatientPhone || 'N/A',
  }));

  return JSON.stringify({
    total: list.length,
    aniversariantes: list,
  });
}

async function executeGetFinancialSummary(dateFrom: string, dateTo: string): Promise<string> {
  const raw = await clinicorp.listFinancialSummary(dateFrom, dateTo);

  if (Array.isArray(raw)) {
    let total = 0;
    const items = raw.map((item: any) => {
      const value = item.Value || item.Amount || item.Total || 0;
      total += value;
      return {
        descricao: item.Description || item.Category || item.PaymentMethod || 'N/A',
        valor: value,
      };
    });
    return JSON.stringify({ valor_total: total, itens: items.slice(0, 30) });
  }

  return JSON.stringify(raw || { error: 'Sem dados financeiros para o período' });
}

async function executeCreateReminder(title: string, datetime: string, phone?: string, recurring?: boolean, user?: UserConfig | null, targetCalendar?: string): Promise<string> {
  const calConfig = resolveCalendarConfig(user, targetCalendar);
  const useCalendar = calConfig && gcal.isAvailable(calConfig);
  console.log(`[Reminder] user=${user?.name || 'null'}, calConfig=${JSON.stringify(calConfig)}, useCalendar=${useCalendar}, target=${targetCalendar || 'own'}`);

  if (useCalendar) {
    const event = await gcal.createEvent(calConfig, {
      title,
      datetime,
      recurring: recurring || false,
    });

    if (event) {
      const remindDate = new Date(datetime);
      return JSON.stringify({
        sucesso: true,
        id: event.id,
        titulo: title,
        horario: remindDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        calendario: targetCalendar || undefined,
        recorrente: recurring || false,
      });
    }

    return JSON.stringify({ sucesso: false, error: 'Não foi possível criar o lembrete' });
  }

  // Fallback → Supabase
  const result = await db.createReminder(title, datetime, phone, recurring);

  if (result) {
    const remindDate = new Date(datetime);
    return JSON.stringify({
      sucesso: true,
      id: result.id,
      titulo: title,
      horario: remindDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      telefone: phone || 'padrão',
      recorrente: recurring || false,
    });
  }

  return JSON.stringify({ sucesso: false, error: 'Não foi possível criar o lembrete' });
}

async function executeConfirmReminderDone(reminderId: string, user?: UserConfig | null, targetCalendar?: string): Promise<string> {
  const calConfig = resolveCalendarConfig(user, targetCalendar);
  const useCalendar = calConfig && gcal.isAvailable(calConfig);

  if (useCalendar) {
    const success = await gcal.markEventDone(calConfig, reminderId);
    return JSON.stringify({
      sucesso: success,
      id: reminderId,
      mensagem: success ? 'Lembrete confirmado como feito!' : 'Não encontrei esse lembrete.',
    });
  }

  const success = await db.confirmReminderDone(reminderId);
  return JSON.stringify({
    sucesso: success,
    id: reminderId,
    mensagem: success ? 'Lembrete confirmado como feito! Não vou mais lembrar.' : 'Não encontrei esse lembrete pendente.',
  });
}

async function executeListReminders(user?: UserConfig | null, targetCalendar?: string): Promise<string> {
  const calConfig = resolveCalendarConfig(user, targetCalendar);
  const useCalendar = calConfig && gcal.isAvailable(calConfig);

  if (useCalendar) {
    // Cross-calendar: mostra eventos do dia (passados + futuros) com status
    if (targetCalendar) {
      const today = getBrtNow().toISOString().split('T')[0];
      const events = await gcal.listEventsForDate(calConfig, today);

      const list = events.map((e) => ({
        id: e.id,
        titulo: e.title,
        horario: e.datetime ? new Date(e.datetime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'N/A',
        recorrente: e.recurring,
        feito: e.done,
      }));

      return JSON.stringify({
        total: list.length,
        lembretes: list,
        calendario: targetCalendar,
        data: today,
      });
    }

    // Calendário próprio: mostra próximos 30 dias
    const events = await gcal.listUpcomingEvents(calConfig, 30);

    const list = events.map((e) => ({
      id: e.id,
      titulo: e.title,
      horario: e.datetime ? new Date(e.datetime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'N/A',
      recorrente: e.recurring,
    }));

    return JSON.stringify({
      total: list.length,
      lembretes: list,
    });
  }

  const reminders = await db.listPendingReminders();

  const list = reminders.map((r) => ({
    id: r.id,
    titulo: r.title,
    horario: new Date(r.remind_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    criado_em: new Date(r.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  }));

  return JSON.stringify({
    total: list.length,
    lembretes: list,
  });
}

async function executeDeleteReminder(reminderId: string, user?: UserConfig | null, targetCalendar?: string): Promise<string> {
  const calConfig = resolveCalendarConfig(user, targetCalendar);
  const useCalendar = calConfig && gcal.isAvailable(calConfig);

  if (useCalendar) {
    const success = await gcal.deleteEvent(calConfig, reminderId);
    return JSON.stringify({
      sucesso: success,
      id: reminderId,
      mensagem: success ? 'Lembrete removido' : 'Não encontrei esse lembrete',
    });
  }

  const success = await db.cancelReminder(reminderId);
  return JSON.stringify({
    sucesso: success,
    id: reminderId,
    mensagem: success ? 'Lembrete cancelado com sucesso' : 'Não foi possível cancelar (já enviado ou não encontrado)',
  });
}

// ── Procedure category keywords ──

const PROCEDURE_CATEGORIES: Record<string, string[]> = {
  revisao: ['revisão', 'revisao', 'retorno', 'controle', 'manutenção', 'manutencao', 'profilaxia', 'limpeza'],
  cirurgia: ['cirurgia', 'extração', 'extracao', 'implante', 'enxerto', 'exodontia', 'siso'],
  estetico: ['botox', 'harmonização', 'harmonizacao', 'clareamento', 'lente', 'faceta', 'preenchimento'],
  ortodontia: ['aparelho', 'ortodontia', 'alinhador', 'manutenção ortodôntica', 'manutencao ortodontica'],
};

function matchesProcedureCategory(procedureText: string, category: string): boolean {
  const keywords = PROCEDURE_CATEGORIES[category];
  if (!keywords) return false;
  const lower = procedureText.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

async function executeQueryProcedures(dateFrom: string, dateTo: string, category?: string): Promise<string> {
  const raw = await clinicorp.listAppointments(dateFrom, dateTo);
  let appointments = Array.isArray(raw) ? raw : [];

  // Filtrar cancelados
  appointments = appointments.filter((a: any) => a.Deleted !== 'X');

  // Filtrar por categoria de procedimento
  if (category) {
    appointments = appointments.filter((a: any) => {
      const proc = (a.Procedures || '') + ' ' + (a.Notes || '');
      return matchesProcedureCategory(proc, category);
    });
  }

  const summary = [];
  for (const a of appointments) {
    const dentistId = a.Dentist_PersonId || a.CreatedUserId;
    const dentistFullName = dentistId ? await getDentistName(dentistId) : 'Sem dentista';

    summary.push({
      paciente: a.PatientName || 'N/A',
      horario: formatTime(a.fromTime || ''),
      data: a.date ? a.date.substring(0, 10) : 'N/A',
      dentista: dentistFullName,
      procedimento: a.Procedures || a.Notes || '',
    });
  }

  return JSON.stringify({
    categoria: category || 'todos',
    total: summary.length,
    agendamentos: summary.slice(0, 50),
  });
}

async function executeUploadPatientPhoto(patientName: string, imageUrl: string): Promise<string> {
  // 1. Buscar paciente no Clinicorp
  const patient = await clinicorp.searchPatient(patientName);
  if (!patient) {
    return JSON.stringify({
      sucesso: false,
      mensagem: `Paciente "${patientName}" não encontrado no Clinicorp. Tente com o nome completo.`,
    });
  }

  // 2. Upload da foto para a ficha
  const result = await clinicorp.uploadFile(patient.PatientId, patient.Name, imageUrl, 'Person.Profile');

  if (result.success) {
    return JSON.stringify({
      sucesso: true,
      paciente: patient.Name,
      patient_id: patient.PatientId,
      mensagem: `Foto adicionada com sucesso na ficha de ${patient.Name} no Clinicorp!`,
    });
  }

  return JSON.stringify({
    sucesso: false,
    paciente: patient.Name,
    erro: result.error || result.status,
    mensagem: `Não consegui fazer upload da foto para ${patient.Name}. Erro: ${result.error || result.status}`,
  });
}

async function executeCreatePhotoReminder(description: string, patientName?: string): Promise<string> {
  const result = await db.createPhotoReminder(description, patientName || null);

  if (result) {
    return JSON.stringify({
      sucesso: true,
      id: result.id,
      descricao: description,
      paciente: patientName || null,
      mensagem: 'Lembrete de foto criado. O sistema vai lembrar a Jéssica automaticamente até ela confirmar.',
    });
  }

  return JSON.stringify({ sucesso: false, error: 'Não foi possível criar o lembrete de foto' });
}

async function executeConfirmPhotoAdded(reminderId: string): Promise<string> {
  const success = await db.confirmPhotoAdded(reminderId);
  return JSON.stringify({
    sucesso: success,
    id: reminderId,
    mensagem: success ? 'Foto confirmada como adicionada no Clinicorp' : 'Não foi possível confirmar (já confirmada ou não encontrada)',
  });
}

async function executeCreateConsentTerm(patientName: string, procedureType: string, appointmentDate: string): Promise<string> {
  const result = await db.createConsentTerm(patientName, procedureType, appointmentDate);

  if (result) {
    return JSON.stringify({
      sucesso: true,
      id: result.id,
      paciente: patientName,
      procedimento: procedureType,
      data: appointmentDate,
      mensagem: 'Termo de consentimento registrado. O sistema vai lembrar até receber o documento.',
    });
  }

  return JSON.stringify({ sucesso: false, error: 'Não foi possível registrar o termo' });
}

async function executeConfirmTermReceived(termId?: string, patientName?: string, date?: string): Promise<string> {
  // Se tem term_id, usa direto
  if (termId) {
    const success = await db.markTermReceived(termId);
    return JSON.stringify({
      sucesso: success,
      id: termId,
      mensagem: success ? 'Termo marcado como recebido' : 'Não foi possível marcar (já recebido ou não encontrado)',
    });
  }

  // Senão, busca por paciente + data
  if (patientName && date) {
    const term = await db.findConsentByPatientAndDate(patientName, date);
    if (term) {
      const success = await db.markTermReceived(term.id);
      return JSON.stringify({
        sucesso: success,
        id: term.id,
        paciente: patientName,
        mensagem: success ? 'Termo marcado como recebido' : 'Termo já foi recebido anteriormente',
      });
    }
    return JSON.stringify({
      sucesso: false,
      mensagem: `Nenhum termo pendente encontrado para ${patientName} na data ${date}`,
    });
  }

  return JSON.stringify({
    sucesso: false,
    mensagem: 'Informe term_id ou patient_name + date para identificar o termo',
  });
}
