import * as clinicorp from './clinicorp';
import * as db from './supabase';

// ── Types ──

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

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
      description: 'Cria um lembrete para a Jéssica. Ela será notificada via WhatsApp no horário especificado. Use para "me lembra de X às 14h", "lembrete para ligar amanhã".',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
          datetime: { type: 'string', description: 'Data/hora do lembrete no formato ISO 8601 com fuso BRT. Ex: "2025-01-15T14:00:00-03:00"' },
        },
        required: ['title', 'datetime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'Lista todos os lembretes pendentes da Jéssica. Use para "quais meus lembretes?", "tenho lembrete pra hoje?".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Cancela/remove um lembrete pelo ID. Use quando Jéssica pedir para cancelar ou remover um lembrete.',
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
      name: 'confirm_photo_added',
      description: 'Confirma que a foto do paciente foi adicionada na ficha do Clinicorp. Use quando Jéssica confirmar que já adicionou a foto (ex: "sim", "feito", "já coloquei", "✅").',
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
      name: 'confirm_term_received',
      description: 'Confirma que o termo de consentimento foi recebido. Use quando Jéssica enviar um PDF/documento de termo escaneado, ou confirmar que o termo foi coletado.',
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

/** Executa uma ferramenta pelo nome e argumentos, retorna string JSON com resultado */
export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
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
        return executeCreateReminder(args.title, args.datetime);

      case 'list_reminders':
        return executeListReminders();

      case 'delete_reminder':
        return executeDeleteReminder(args.reminder_id);

      case 'query_procedures':
        return executeQueryProcedures(args.date_from, args.date_to, args.category);

      case 'confirm_photo_added':
        return executeConfirmPhotoAdded(args.reminder_id);

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

async function executeCreateReminder(title: string, datetime: string): Promise<string> {
  const result = await db.createReminder(title, datetime);

  if (result) {
    const remindDate = new Date(datetime);
    return JSON.stringify({
      sucesso: true,
      id: result.id,
      titulo: title,
      horario: remindDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    });
  }

  return JSON.stringify({ sucesso: false, error: 'Não foi possível criar o lembrete' });
}

async function executeListReminders(): Promise<string> {
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

async function executeDeleteReminder(reminderId: string): Promise<string> {
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

async function executeConfirmPhotoAdded(reminderId: string): Promise<string> {
  const success = await db.confirmPhotoAdded(reminderId);
  return JSON.stringify({
    sucesso: success,
    id: reminderId,
    mensagem: success ? 'Foto confirmada como adicionada no Clinicorp' : 'Não foi possível confirmar (já confirmada ou não encontrada)',
  });
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
