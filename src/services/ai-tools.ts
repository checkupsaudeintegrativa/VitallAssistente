import * as clinicorp from './clinicorp';
import * as db from './supabase';
import * as gcal from './google-calendar';
import * as gmail from './gmail';
import * as ponto from './ponto-report';
import * as evolution from './evolution';
import { UserConfig, GoogleCalendarConfig } from '../config/users';

// ── Types ──

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** Ferramentas restritas a admin (não disponíveis para staff) */
const FINANCIAL_TOOLS = new Set([
  'query_payments', 'get_financial_summary',
  'query_contas_pagar', 'create_conta_pagar', 'update_conta_pagar',
  'dar_baixa_conta', 'delete_conta_pagar', 'get_contas_summary',
  'sync_bank_transactions',
]);

/** Ferramentas de edição de ponto — somente admin */
const PONTO_EDIT_TOOLS = new Set(['add_ponto_record', 'delete_ponto_record', 'generate_ponto_pdf', 'set_ausencia', 'delete_ausencia', 'set_saldo_snapshot']);

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
      description: 'Cria um lembrete. Se não tiver horário, calcule: agora + 3h (mas NUNCA depois das 17h30 BRT — se passar, use 17h30 BRT do mesmo dia ou 7h30 BRT do dia seguinte). SEMPRE use recurring:true por padrão (envia no horário + digest 7h30/17h todo dia até confirmar feito). Só use recurring:false se a pessoa disser explicitamente "só uma vez" ou "não precisa lembrar de novo".',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
          datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2025-01-15T14:00:00-03:00". Se não tiver horário, calcule +3h capped 17h30 BRT.' },
          phone: { type: 'string', description: 'Telefone de quem pediu (do contexto [Contexto]). Ex: "5511943635555"' },
          recurring: { type: 'boolean', description: 'SEMPRE true por padrão. Só use false se a pessoa pedir explicitamente "só uma vez" ou "não precisa lembrar de novo".' },
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
  // ── Ponto (controle de ponto) ──
  {
    type: 'function',
    function: {
      name: 'query_ponto',
      description: 'Consulta registros de ponto de um funcionário em uma data. Para staff, busca automaticamente pelo próprio nome. Para admin, pode consultar qualquer funcionário.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário (opcional para admin; ignorado para staff, que consulta o próprio ponto)' },
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_ponto_record',
      description: 'Adiciona um registro de ponto para um funcionário. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário' },
          datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2026-02-23T12:53:00-03:00"' },
          tipo: { type: 'string', description: 'Tipo do registro: "entrada" ou "saida"' },
        },
        required: ['employee_name', 'datetime', 'tipo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_ponto_record',
      description: 'Remove um registro de ponto pelo ID. Use query_ponto antes para encontrar o ID do registro. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          record_id: { type: 'string', description: 'UUID do registro de ponto a remover' },
        },
        required: ['record_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_ponto_pdf',
      description: 'Gera e envia o relatório de ponto PDF de um funcionário via WhatsApp para quem pediu. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário' },
          phone: { type: 'string', description: 'Telefone de quem pediu (do [Contexto]) — para enviar o PDF' },
          week_date: { type: 'string', description: 'Data YYYY-MM-DD dentro da semana desejada (opcional, padrão = semana anterior)' },
        },
        required: ['employee_name', 'phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_ausencia',
      description: 'Marca uma ausência (feriado, férias, atestado ou falta) para um funcionário em uma data. Faz upsert — se já existir, atualiza. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário' },
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          tipo: { type: 'string', description: 'Tipo de ausência: "feriado", "ferias", "atestado" ou "falta"' },
          observacao: { type: 'string', description: 'Observação opcional (ex: "Carnaval", "Atestado Dr. Fulano")' },
        },
        required: ['employee_name', 'date', 'tipo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_ausencia',
      description: 'Remove uma ausência marcada para um funcionário em uma data. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário' },
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['employee_name', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_saldo_snapshot',
      description: 'Define o saldo acumulado (snapshot) de um funcionário. A partir da data de referência, o sistema calculará automaticamente o saldo total somando o snapshot + saldos diários. Somente admin.',
      parameters: {
        type: 'object',
        properties: {
          employee_name: { type: 'string', description: 'Nome do funcionário' },
          saldo_minutos: { type: 'number', description: 'Saldo acumulado em minutos (positivo ou negativo). Ex: +3h05 = 185, -1h30 = -90' },
          data_referencia: { type: 'string', description: 'Data de referência no formato YYYY-MM-DD. O saldo diário será calculado a partir desta data.' },
        },
        required: ['employee_name', 'saldo_minutos', 'data_referencia'],
      },
    },
  },
  // ── Contas a Pagar ──
  {
    type: 'function',
    function: {
      name: 'query_contas_pagar',
      description: 'Lista contas a pagar num intervalo de datas (por vencimento). Filtra por status, categoria e classificação. Use para "contas a pagar desse mês", "contas vencidas", "quanto devo de laboratório".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD (vencimento)' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD (vencimento)' },
          status: { type: 'string', description: 'Filtrar por status: "aberto", "realizado" ou "todos" (default: "todos")' },
          categoria: { type: 'string', description: 'Filtrar por categoria (ex: "LABORATÓRIO", "IMPOSTOS", "MATERIAL"). Opcional.' },
          classificacao: { type: 'string', description: 'Filtrar por classificação (ex: "CUSTO FIXO", "CUSTO VARIÁVEL"). Opcional.' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_conta_pagar',
      description: 'Cria uma nova conta a pagar. Use quando o usuário pedir para registrar uma despesa, boleto, conta. Sempre confirme os dados antes de criar.',
      parameters: {
        type: 'object',
        properties: {
          descricao: { type: 'string', description: 'Descrição da conta (ex: "Protético João - caso Maria")' },
          valor: { type: 'number', description: 'Valor em reais (ex: 500.00)' },
          vencimento: { type: 'string', description: 'Data de vencimento no formato YYYY-MM-DD' },
          categoria: { type: 'string', description: 'Categoria (ex: "LABORATÓRIO", "IMPOSTOS", "MATERIAL", "ALUGUEL"). Opcional.' },
          classificacao: { type: 'string', description: 'Classificação (ex: "CUSTO FIXO", "CUSTO VARIÁVEL"). Opcional.' },
          competencia: { type: 'string', description: 'Mês de competência no formato YYYY-MM (ex: "2026-03"). Opcional, default = mês do vencimento.' },
          forma_pagamento: { type: 'string', description: 'Forma de pagamento (ex: "PIX", "BOLETO", "CARTÃO"). Opcional.' },
          fornecedor_documento: { type: 'string', description: 'CPF/CNPJ do fornecedor. Opcional.' },
          observacoes: { type: 'string', description: 'Observações adicionais. Opcional.' },
        },
        required: ['descricao', 'valor', 'vencimento'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_conta_pagar',
      description: 'Altera uma conta a pagar existente. Use para corrigir valor, vencimento, categoria, etc. Sempre confirme as alterações com o usuário.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID da conta a pagar' },
          descricao: { type: 'string', description: 'Nova descrição. Opcional.' },
          valor: { type: 'number', description: 'Novo valor. Opcional.' },
          vencimento: { type: 'string', description: 'Nova data de vencimento YYYY-MM-DD. Opcional.' },
          categoria: { type: 'string', description: 'Nova categoria. Opcional.' },
          classificacao: { type: 'string', description: 'Nova classificação. Opcional.' },
          competencia: { type: 'string', description: 'Nova competência YYYY-MM. Opcional.' },
          forma_pagamento: { type: 'string', description: 'Nova forma de pagamento. Opcional.' },
          observacoes: { type: 'string', description: 'Novas observações. Opcional.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dar_baixa_conta',
      description: 'Marca uma conta a pagar como paga (dá baixa). Use quando o usuário disser "dá baixa", "paguei", "já paguei".',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID da conta a pagar' },
          data_pagamento: { type: 'string', description: 'Data do pagamento YYYY-MM-DD. Se omitido, usa a data de hoje.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_conta_pagar',
      description: 'Exclui uma conta a pagar. Sempre confirme com o usuário antes de excluir.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID da conta a pagar' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_contas_summary',
      description: 'Gera relatório/resumo de contas a pagar num período, agrupado por categoria, classificação ou status. Use para "quanto gastei com impostos", "resumo de despesas do mês", "quanto retirei".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD (vencimento)' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD (vencimento)' },
          agrupar_por: { type: 'string', description: 'Agrupar por: "categoria" (default), "classificacao" ou "status"' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  // ── Importação bancária (Gmail / C6 Bank) ──
  {
    type: 'function',
    function: {
      name: 'sync_bank_transactions',
      description: 'Busca saídas bancárias (C6 Bank) de uma data no Gmail e cria automaticamente as contas a pagar já com baixa (status=realizado). Use para "sincronizar banco de hoje", "importar saídas do banco", "puxar extrato", "transações do banco".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['date'],
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
    ? toolDefinitions.filter((t) => !FINANCIAL_TOOLS.has(t.function.name) && !PONTO_EDIT_TOOLS.has(t.function.name))
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
            description: 'Cria um lembrete. NÃO precisa do parâmetro phone. Se não tiver horário, calcule: agora + 3h (mas NUNCA depois das 17h30 BRT). SEMPRE use recurring:true por padrão (envia no horário + digest 7h30/17h todo dia até confirmar feito). Só use recurring:false se a pessoa disser explicitamente "só uma vez" ou "não precisa lembrar de novo".',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
                datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2025-01-15T14:00:00-03:00". Se não tiver horário, calcule +3h capped 17h30 BRT.' },
                phone: { type: 'string', description: 'Opcional — ignorado.' },
                recurring: { type: 'boolean', description: 'SEMPRE true por padrão. Só use false se a pessoa pedir explicitamente "só uma vez" ou "não precisa lembrar de novo".' },
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

/** Retorna toolDefinitions filtradas por uma lista de nomes */
export function getToolsByNames(names: string[]): ToolDefinition[] {
  const nameSet = new Set(names);
  return toolDefinitions.filter((t) => nameSet.has(t.function.name));
}

/**
 * Adapta as tools de lembrete para Google Calendar (target_calendar, remove phone, etc.)
 * Extraído de getToolsForUser para uso pelo sistema de agentes.
 */
export function adaptCalendarTools(tools: ToolDefinition[], user?: UserConfig | null): ToolDefinition[] {
  const calConfig = user?.features?.googleCalendar;
  if (!calConfig || !gcal.isAvailable(calConfig)) return tools;

  const hasCrossCalendars = calConfig.crossCalendars && calConfig.crossCalendars.length > 0;
  const crossNames = calConfig.crossCalendars?.map((c) => c.name).join(', ') || '';

  const createTargetParam = hasCrossCalendars
    ? { target_calendar: { type: 'string', description: `Calendário alvo. Omita para usar o seu próprio. Valores possíveis: ${crossNames}` } }
    : {};

  const viewableCross = calConfig.crossCalendars?.filter((c) => c.canView) || [];
  const viewNames = viewableCross.map((c) => c.name).join(', ');
  const viewTargetParam = viewableCross.length > 0
    ? { target_calendar: { type: 'string', description: `Calendário alvo. Omita para usar o seu próprio. Valores possíveis: ${viewNames}` } }
    : {};

  return tools.map((t) => {
    if (t.function.name === 'create_reminder') {
      return {
        ...t,
        function: {
          ...t.function,
          description: 'Cria um lembrete. NÃO precisa do parâmetro phone. Se não tiver horário, calcule: agora + 3h (mas NUNCA depois das 17h30 BRT). SEMPRE use recurring:true por padrão.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Descrição do lembrete. Ex: "Ligar para paciente Maria"' },
              datetime: { type: 'string', description: 'Data/hora no formato ISO 8601. Ex: "2025-01-15T14:00:00-03:00". Se não tiver horário, calcule +3h capped 17h30 BRT.' },
              phone: { type: 'string', description: 'Opcional — ignorado.' },
              recurring: { type: 'boolean', description: 'SEMPRE true por padrão. Só use false se a pessoa pedir explicitamente "só uma vez".' },
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
          parameters: { type: 'object', properties: { ...viewTargetParam }, required: [] },
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

/** Executa uma ferramenta pelo nome e argumentos, retorna string JSON com resultado */
export async function executeTool(name: string, args: Record<string, any>, user?: UserConfig | null): Promise<string> {
  // Guard: staff não pode usar ferramentas financeiras
  if (user && user.role !== 'admin' && FINANCIAL_TOOLS.has(name)) {
    return JSON.stringify({
      error: 'Sem permissão',
      mensagem: `Você não tem acesso a informações financeiras. Fale com o Arthur ou a Dra. Ana para consultas financeiras.`,
    });
  }

  // Guard: staff não pode editar registros de ponto
  if (user && user.role !== 'admin' && PONTO_EDIT_TOOLS.has(name)) {
    return JSON.stringify({
      error: 'Sem permissão',
      mensagem: `Você não tem permissão para editar registros de ponto. Fale com a Dra. Ana.`,
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

      case 'query_ponto':
        return executeQueryPonto(args.employee_name, args.date, user);

      case 'add_ponto_record':
        return executeAddPontoRecord(args.employee_name, args.datetime, args.tipo);

      case 'delete_ponto_record':
        return executeDeletePontoRecord(args.record_id);

      case 'generate_ponto_pdf':
        return executeGeneratePontoPdf(args.employee_name, args.phone, args.week_date);

      case 'set_ausencia':
        return executeSetAusencia(args.employee_name, args.date, args.tipo, args.observacao);

      case 'delete_ausencia':
        return executeDeleteAusencia(args.employee_name, args.date);

      case 'set_saldo_snapshot':
        return executeSetSaldoSnapshot(args.employee_name, args.saldo_minutos, args.data_referencia);

      // ── Contas a Pagar ──
      case 'query_contas_pagar':
        return executeQueryContasPagar(args.date_from, args.date_to, args.status, args.categoria, args.classificacao);

      case 'create_conta_pagar':
        return executeCreateContaPagar(args);

      case 'update_conta_pagar':
        return executeUpdateContaPagar(args);

      case 'dar_baixa_conta':
        return executeDarBaixaConta(args.id, args.data_pagamento);

      case 'delete_conta_pagar':
        return executeDeleteContaPagar(args.id);

      case 'get_contas_summary':
        return executeGetContasSummary(args.date_from, args.date_to, args.agrupar_por);

      case 'sync_bank_transactions':
        return executeSyncBankTransactions(args.date);

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
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())}`;
  const time = `${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}`;
  const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  return JSON.stringify({
    agora_iso: `${date}T${time}:00-03:00`,
    date,
    time,
    weekday: weekdays[brt.getUTCDay()],
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

// ── Ponto executors ──

async function executeQueryPonto(employeeName: string | undefined, date: string, user?: UserConfig | null): Promise<string> {
  // Staff: sempre busca pelo próprio nome
  const searchName = (user && user.role !== 'admin') ? user.name : (employeeName || user?.name || '');
  if (!searchName) {
    return JSON.stringify({ error: 'Nome do funcionário não informado' });
  }

  const func = await ponto.findFuncionarioByName(searchName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${searchName}" não encontrado no sistema de ponto` });
  }

  const registros = await ponto.getRegistrosByDate(func.id, date);

  // Buscar ausência do dia
  const ausencias = await ponto.getAusenciasByPeriod(func.id, date, date);
  const ausencia = ausencias.length > 0 ? ausencias[0] : null;

  // Montar pares entrada/saída e calcular horas
  const items = registros.map((r) => ({
    id: r.id,
    hora: ponto.fmtHour(r.data_hora),
    tipo: r.tipo,
    data_hora: r.data_hora,
  }));

  // Calcular total de minutos trabalhados
  let totalMinutos = 0;
  for (let i = 0; i < registros.length; i += 2) {
    const ent = registros[i];
    const sai = i + 1 < registros.length ? registros[i + 1] : null;
    if (ent && sai) {
      const diff = Math.max(0, Math.round(
        (new Date(sai.data_hora).getTime() - new Date(ent.data_hora).getTime()) / 60000
      ));
      totalMinutos += diff;
    }
  }

  // Horas esperadas para o dia
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  let esperado = ponto.horasEsperadasDia(dow);
  let saldo = totalMinutos - esperado;

  // Se há ausência tipo feriado/férias/atestado → saldo neutro
  if (ausencia && (ausencia.tipo === 'feriado' || ausencia.tipo === 'ferias' || ausencia.tipo === 'atestado')) {
    esperado = 0;
    saldo = 0;
  }

  const result: Record<string, any> = {
    funcionario: func.nome,
    data: date,
    registros: items,
    total_registros: items.length,
    total_trabalhado: ponto.minutosParaHoras(totalMinutos),
    total_trabalhado_minutos: totalMinutos,
    horas_esperadas: ponto.minutosParaHoras(esperado),
    saldo: ponto.minutosParaHoras(saldo),
  };

  if (ausencia) {
    result.ausencia = { tipo: ausencia.tipo, observacao: ausencia.observacao || null };
  }

  // Calcular saldo total acumulado (snapshot + período desde referência)
  const saldoTotalAcumulado = await ponto.calcSaldoTotal(func, date);
  if (saldoTotalAcumulado !== null) {
    result.saldo_total = ponto.minutosParaHoras(saldoTotalAcumulado);
    result.saldo_total_minutos = saldoTotalAcumulado;
  }

  return JSON.stringify(result);
}

async function executeAddPontoRecord(employeeName: string, datetime: string, tipo: string): Promise<string> {
  const func = await ponto.findFuncionarioByName(employeeName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${employeeName}" não encontrado no sistema de ponto` });
  }

  const result = await ponto.addRegistroPonto(func.id, func.nome, datetime, tipo);
  if (!result) {
    return JSON.stringify({ error: 'Não foi possível adicionar o registro de ponto' });
  }

  // Retornar registros atualizados do dia
  const date = datetime.split('T')[0];
  const registros = await ponto.getRegistrosByDate(func.id, date);
  const items = registros.map((r) => ({
    id: r.id,
    hora: ponto.fmtHour(r.data_hora),
    tipo: r.tipo,
  }));

  return JSON.stringify({
    sucesso: true,
    id: result.id,
    funcionario: func.nome,
    data: date,
    tipo,
    registros_atualizados: items,
    mensagem: `Registro de ${tipo} adicionado para ${func.nome}`,
  });
}

async function executeDeletePontoRecord(recordId: string): Promise<string> {
  const success = await ponto.deleteRegistroPonto(recordId);
  return JSON.stringify({
    sucesso: success,
    id: recordId,
    mensagem: success ? 'Registro de ponto removido com sucesso' : 'Não foi possível remover o registro (não encontrado ou erro)',
  });
}

async function executeGeneratePontoPdf(employeeName: string, phone: string, weekDate?: string): Promise<string> {
  const func = await ponto.findFuncionarioByName(employeeName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${employeeName}" não encontrado no sistema de ponto` });
  }

  const report = await ponto.generateSingleReport(func.id, weekDate);
  if (!report) {
    return JSON.stringify({ error: 'Não foi possível gerar o relatório de ponto' });
  }

  // Enviar PDF via WhatsApp
  const base64 = report.buffer.toString('base64');
  const sent = await evolution.sendMedia(
    phone,
    base64,
    report.fileName,
    `Relatório de ponto - ${report.funcionarioNome}`,
  );

  return JSON.stringify({
    sucesso: sent,
    funcionario: report.funcionarioNome,
    arquivo: report.fileName,
    mensagem: sent
      ? `PDF do relatório de ponto de ${report.funcionarioNome} enviado com sucesso!`
      : 'Erro ao enviar o PDF via WhatsApp',
  });
}

// ── Ausência executors ──

async function executeSetAusencia(employeeName: string, date: string, tipo: string, observacao?: string): Promise<string> {
  const func = await ponto.findFuncionarioByName(employeeName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${employeeName}" não encontrado no sistema de ponto` });
  }

  const validTipos = ['feriado', 'ferias', 'atestado', 'falta'] as const;
  if (!validTipos.includes(tipo as any)) {
    return JSON.stringify({ error: `Tipo inválido: "${tipo}". Use: feriado, ferias, atestado ou falta` });
  }

  const result = await ponto.setAusencia(func.id, date, tipo as any, observacao);
  if (!result) {
    return JSON.stringify({ error: 'Não foi possível registrar a ausência' });
  }

  const tipoLabel: Record<string, string> = {
    feriado: 'Feriado',
    ferias: 'Férias',
    atestado: 'Atestado',
    falta: 'Falta',
  };

  return JSON.stringify({
    sucesso: true,
    id: result.id,
    funcionario: func.nome,
    data: date,
    tipo: tipoLabel[tipo] || tipo,
    observacao: observacao || null,
    mensagem: `${tipoLabel[tipo] || tipo} registrado para ${func.nome} em ${date}`,
  });
}

async function executeDeleteAusencia(employeeName: string, date: string): Promise<string> {
  const func = await ponto.findFuncionarioByName(employeeName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${employeeName}" não encontrado no sistema de ponto` });
  }

  const success = await ponto.deleteAusencia(func.id, date);
  return JSON.stringify({
    sucesso: success,
    funcionario: func.nome,
    data: date,
    mensagem: success
      ? `Ausência removida para ${func.nome} em ${date}`
      : 'Não foi possível remover a ausência (não encontrada ou erro)',
  });
}

async function executeSetSaldoSnapshot(employeeName: string, saldoMinutos: number, dataReferencia: string): Promise<string> {
  const func = await ponto.findFuncionarioByName(employeeName);
  if (!func) {
    return JSON.stringify({ error: `Funcionário "${employeeName}" não encontrado no sistema de ponto` });
  }

  const success = await ponto.updateSaldoSnapshot(func.id, saldoMinutos, dataReferencia);
  if (!success) {
    return JSON.stringify({ error: 'Não foi possível atualizar o saldo snapshot' });
  }

  const sinal = saldoMinutos >= 0 ? '+' : '';
  return JSON.stringify({
    sucesso: true,
    funcionario: func.nome,
    saldo_minutos: saldoMinutos,
    saldo_formatado: `${sinal}${ponto.minutosParaHoras(saldoMinutos)}`,
    data_referencia: dataReferencia,
    mensagem: `Saldo acumulado de ${func.nome} definido para ${sinal}${ponto.minutosParaHoras(saldoMinutos)} a partir de ${dataReferencia}`,
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

// ── Contas a Pagar executors ──

async function executeQueryContasPagar(
  dateFrom: string,
  dateTo: string,
  status?: string,
  categoria?: string,
  classificacao?: string,
): Promise<string> {
  const { supabase } = await import('./supabase');

  let query = supabase
    .from('contas_pagar')
    .select('id, descricao, valor, vencimento, status, categoria, classificacao, competencia, forma_pagamento, data_pagamento')
    .gte('vencimento', dateFrom)
    .lte('vencimento', dateTo)
    .order('vencimento', { ascending: true })
    .limit(50);

  if (status && status !== 'todos') {
    query = query.eq('status', status);
  }
  if (categoria) {
    query = query.ilike('categoria', `%${categoria}%`);
  }
  if (classificacao) {
    query = query.ilike('classificacao', `%${classificacao}%`);
  }

  const { data, error } = await query;
  if (error) {
    return JSON.stringify({ error: `Erro ao consultar contas a pagar: ${error.message}` });
  }

  const contas = data || [];
  const valorTotal = contas.reduce((sum: number, c: any) => sum + (c.valor || 0), 0);

  return JSON.stringify({
    total: contas.length,
    valor_total: valorTotal,
    contas: contas.map((c: any) => ({
      id: c.id,
      descricao: c.descricao,
      valor: c.valor,
      vencimento: c.vencimento,
      status: c.status,
      categoria: c.categoria || '',
      classificacao: c.classificacao || '',
    })),
  });
}

async function executeCreateContaPagar(args: Record<string, any>): Promise<string> {
  const { supabase } = await import('./supabase');

  const competencia = args.competencia || (args.vencimento ? args.vencimento.substring(0, 7) : undefined);

  const row: Record<string, any> = {
    descricao: args.descricao,
    valor: args.valor,
    vencimento: args.vencimento,
    status: 'aberto',
  };
  if (competencia) row.competencia = competencia;
  if (args.categoria) row.categoria = args.categoria;
  if (args.classificacao) row.classificacao = args.classificacao;
  if (args.forma_pagamento) row.forma_pagamento = args.forma_pagamento;
  if (args.fornecedor_documento) row.fornecedor_documento = args.fornecedor_documento;
  if (args.observacoes) row.observacoes = args.observacoes;

  const { data, error } = await supabase
    .from('contas_pagar')
    .insert(row)
    .select()
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao criar conta a pagar: ${error.message}` });
  }

  return JSON.stringify({
    sucesso: true,
    conta: {
      id: data.id,
      descricao: data.descricao,
      valor: data.valor,
      vencimento: data.vencimento,
      status: data.status,
      categoria: data.categoria || '',
    },
    mensagem: `Conta criada: "${data.descricao}" - R$ ${data.valor.toFixed(2)} vencimento ${data.vencimento}`,
  });
}

async function executeUpdateContaPagar(args: Record<string, any>): Promise<string> {
  const { supabase } = await import('./supabase');

  const { id, ...fields } = args;
  // Remove campos undefined
  const updates: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined && val !== null) updates[key] = val;
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'Nenhum campo para atualizar informado' });
  }

  const { data, error } = await supabase
    .from('contas_pagar')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao atualizar conta: ${error.message}` });
  }

  return JSON.stringify({
    sucesso: true,
    conta: {
      id: data.id,
      descricao: data.descricao,
      valor: data.valor,
      vencimento: data.vencimento,
      status: data.status,
      categoria: data.categoria || '',
    },
    mensagem: `Conta "${data.descricao}" atualizada com sucesso`,
  });
}

async function executeDarBaixaConta(id: string, dataPagamento?: string): Promise<string> {
  const { supabase } = await import('./supabase');

  const hoje = getBrtNow().toISOString().split('T')[0];
  const dataPgto = dataPagamento || hoje;

  const { data, error } = await supabase
    .from('contas_pagar')
    .update({ status: 'realizado', data_pagamento: dataPgto })
    .eq('id', id)
    .select('id, descricao, valor')
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao dar baixa: ${error.message}` });
  }

  return JSON.stringify({
    sucesso: true,
    id: data.id,
    mensagem: `Conta "${data.descricao}" (R$ ${data.valor.toFixed(2)}) marcada como paga em ${dataPgto}`,
  });
}

async function executeDeleteContaPagar(id: string): Promise<string> {
  const { supabase } = await import('./supabase');

  // Buscar a conta antes de excluir para retornar info
  const { data: conta } = await supabase
    .from('contas_pagar')
    .select('id, descricao, valor')
    .eq('id', id)
    .single();

  const { error } = await supabase
    .from('contas_pagar')
    .delete()
    .eq('id', id);

  if (error) {
    return JSON.stringify({ error: `Erro ao excluir conta: ${error.message}` });
  }

  return JSON.stringify({
    sucesso: true,
    id,
    mensagem: conta
      ? `Conta "${conta.descricao}" (R$ ${conta.valor.toFixed(2)}) excluída`
      : `Conta ${id} excluída`,
  });
}

async function executeGetContasSummary(
  dateFrom: string,
  dateTo: string,
  agruparPor?: string,
): Promise<string> {
  const { supabase } = await import('./supabase');

  const groupField = agruparPor === 'classificacao' ? 'classificacao'
    : agruparPor === 'status' ? 'status'
    : 'categoria';

  const { data, error } = await supabase
    .from('contas_pagar')
    .select('valor, status, categoria, classificacao')
    .gte('vencimento', dateFrom)
    .lte('vencimento', dateTo);

  if (error) {
    return JSON.stringify({ error: `Erro ao gerar resumo: ${error.message}` });
  }

  const contas = data || [];
  let totalGeral = 0;
  let totalAberto = 0;
  let totalRealizado = 0;

  const grupoMap: Record<string, { total: number; quantidade: number }> = {};

  for (const c of contas) {
    const valor = c.valor || 0;
    totalGeral += valor;
    if (c.status === 'aberto') totalAberto += valor;
    if (c.status === 'realizado') totalRealizado += valor;

    const grupoKey = (c[groupField as keyof typeof c] as string) || 'Sem classificação';
    if (!grupoMap[grupoKey]) grupoMap[grupoKey] = { total: 0, quantidade: 0 };
    grupoMap[grupoKey].total += valor;
    grupoMap[grupoKey].quantidade++;
  }

  const grupos = Object.entries(grupoMap)
    .map(([nome, info]) => ({ nome, total: info.total, quantidade: info.quantidade }))
    .sort((a, b) => b.total - a.total);

  return JSON.stringify({
    periodo: `${dateFrom} a ${dateTo}`,
    total_contas: contas.length,
    total_geral: totalGeral,
    total_aberto: totalAberto,
    total_realizado: totalRealizado,
    agrupado_por: groupField,
    grupos,
  });
}

// ── Importação bancária (Gmail / C6 Bank) ──

// ── Classificação inteligente de transações bancárias ──

interface ContaClassificacao {
  descricao: string;
  categoria: string;
  classificacao: string;
}

/** Mapa de keywords do destinatário → classificação da conta */
const RECIPIENT_RULES: Array<{ keywords: string[]; result: Omit<ContaClassificacao, 'descricao'> & { descPrefix: string } }> = [
  // Profissionais (doutoras — custo variável)
  { keywords: ['marcela'], result: { descPrefix: 'Dra. Marcela', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['maria eduarda'], result: { descPrefix: 'Dra. Maria Eduarda', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['giovanna'], result: { descPrefix: 'Dra. Giovanna', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['victoria', 'victória', 'vitória'], result: { descPrefix: 'Dra. Victória', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['fabiana'], result: { descPrefix: 'Dra. Fabiana', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['rodolfo'], result: { descPrefix: 'Dr. Rodolfo', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  { keywords: ['pedro henrique cardoso'], result: { descPrefix: 'Pedro Henrique', categoria: 'ANTECIPAÇÃO DE LUCROS', classificacao: 'Outros' } },
  { keywords: ['pedro'], result: { descPrefix: 'Dr. Pedro', categoria: 'PROFISSIONAIS', classificacao: 'Custo Variável' } },
  // Profissionais (funcionárias — custo fixo)
  { keywords: ['jessica', 'jéssica'], result: { descPrefix: 'Jéssica', categoria: 'PROFISSIONAIS', classificacao: 'Custo Fixo' } },
  { keywords: ['thamires'], result: { descPrefix: 'Thamires', categoria: 'PROFISSIONAIS', classificacao: 'Custo Fixo' } },
  { keywords: ['pamela', 'pâmela'], result: { descPrefix: 'Pâmela', categoria: 'PROFISSIONAIS', classificacao: 'Custo Fixo' } },
  // Radiologia
  { keywords: ['radiologic'], result: { descPrefix: 'Radiologic', categoria: 'RADIOLOGIA', classificacao: 'Custo Variável' } },
  { keywords: ['cedor'], result: { descPrefix: 'Cedor', categoria: 'RADIOLOGIA', classificacao: 'Custo Variável' } },
  // Laboratório
  { keywords: ['lisboa'], result: { descPrefix: 'Laboratório Lisboa', categoria: 'LABORATÓRIO', classificacao: 'Custo Variável' } },
  { keywords: ['inova'], result: { descPrefix: 'Laboratório Inova', categoria: 'LABORATÓRIO', classificacao: 'Custo Variável' } },
  { keywords: ['clearcorrect', 'clear correct'], result: { descPrefix: 'ClearCorrect', categoria: 'LABORATÓRIO', classificacao: 'Custo Variável' } },
  { keywords: ['claudio roberto'], result: { descPrefix: 'Laboratório Cláudio', categoria: 'LABORATÓRIO', classificacao: 'Custo Variável' } },
  // Dental
  { keywords: ['dental med'], result: { descPrefix: 'Dental Med Sul', categoria: 'DENTAL', classificacao: 'Custo Variável' } },
  { keywords: ['dental speed'], result: { descPrefix: 'Dental Speed', categoria: 'DENTAL', classificacao: 'Custo Variável' } },
  { keywords: ['dental tanaka'], result: { descPrefix: 'Dental Tanaka', categoria: 'DENTAL', classificacao: 'Custo Variável' } },
  // Componentes / Implantes
  { keywords: ['wallace'], result: { descPrefix: 'Wallace Componentes', categoria: 'COMPONENTES WALLACE', classificacao: 'Custo Variável' } },
  // Infraestrutura / Fornecedores
  { keywords: ['shibata'], result: { descPrefix: 'Shibata', categoria: 'INFRAESTRUTURA', classificacao: 'Custo Variável' } },
  { keywords: ['alumifran'], result: { descPrefix: 'Alumifran', categoria: 'INFRAESTRUTURA', classificacao: 'Custo Variável' } },
  { keywords: ['infinitepay', 'infinite pay'], result: { descPrefix: 'Maquininha InfinitePay', categoria: 'INFRAESTRUTURA', classificacao: 'Investimento' } },
  // Manutenção
  { keywords: ['mogiteq'], result: { descPrefix: 'Mogiteq', categoria: 'MANUTENÇÃO', classificacao: 'Custo Variável' } },
  { keywords: ['elkertec'], result: { descPrefix: 'Elkertec', categoria: 'MANUTENÇÃO', classificacao: 'Custo Variável' } },
  // Marketing
  { keywords: ['google'], result: { descPrefix: 'Campanha Google', categoria: 'MARKETING', classificacao: 'Custo Fixo' } },
  // Antecipação de lucros (família da Dra. Ana)
  { keywords: ['ana maria'], result: { descPrefix: 'Dra. Ana Maria', categoria: 'ANTECIPAÇÃO DE LUCROS', classificacao: 'Outros' } },
  { keywords: ['ana carolina cardoso'], result: { descPrefix: 'Ana Carolina', categoria: 'ANTECIPAÇÃO DE LUCROS', classificacao: 'Outros' } },
  { keywords: ['arthur gabriel'], result: { descPrefix: 'Arthur Gabriel', categoria: 'ANTECIPAÇÃO DE LUCROS', classificacao: 'Outros' } },
  { keywords: ['cezar augusto'], result: { descPrefix: 'Cezar Augusto', categoria: 'ANTECIPAÇÃO DE LUCROS', classificacao: 'Outros' } },
];

/** Classifica uma transação bancária baseado no nome do destinatário */
function classifyTransaction(recipient: string, rawBody: string): ContaClassificacao {
  const searchText = `${recipient}\n${rawBody}`.toLowerCase();

  for (const rule of RECIPIENT_RULES) {
    if (rule.keywords.some((kw) => searchText.includes(kw))) {
      return {
        descricao: `Pagamento ${rule.result.descPrefix}`,
        categoria: rule.result.categoria,
        classificacao: rule.result.classificacao,
      };
    }
  }

  // Fallback: usa o nome do destinatário como descrição
  const shortRecipient = recipient
    ? recipient.split(/\s+/).slice(0, 3).join(' ')
    : 'Transação C6 Bank';

  return {
    descricao: `Pix para ${shortRecipient}`,
    categoria: 'BANCO',
    classificacao: 'Custo Variável',
  };
}

async function executeSyncBankTransactions(date: string): Promise<string> {
  if (!gmail.isAvailable()) {
    return JSON.stringify({
      error: 'Gmail não configurado',
      mensagem: 'As credenciais do Gmail (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) não estão configuradas.',
    });
  }

  let transactions;
  try {
    transactions = await gmail.fetchC6BankTransactions(date);
  } catch (err: any) {
    console.error(`[SyncBank] Erro ao buscar emails do Gmail: ${err.message}`);
    return JSON.stringify({
      error: 'Erro ao acessar Gmail',
      mensagem: `Não foi possível acessar o Gmail: ${err.message}. Verifique se as credenciais (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) estão corretas.`,
    });
  }

  const saidas = transactions.filter((t) => t.type === 'saida');

  if (saidas.length === 0) {
    return JSON.stringify({
      sincronizadas: 0,
      ja_existentes: 0,
      total_saidas: 0,
      valor_total: 0,
      mensagem: `Nenhuma saída bancária encontrada para ${date}`,
    });
  }

  const { supabase } = await import('./supabase');
  const competencia = date.substring(0, 7); // YYYY-MM

  let sincronizadas = 0;
  let jaExistentes = 0;
  let valorTotal = 0;
  const contasCriadas: Array<{ descricao: string; valor: number; categoria: string }> = [];

  for (const tx of saidas) {
    // Dedup: verificar se já existe conta com esse emailMessageId no campo observacoes
    const marker = `gmail:${tx.emailMessageId}`;
    const { data: existing } = await supabase
      .from('contas_pagar')
      .select('id')
      .ilike('observacoes', `%${marker}%`)
      .limit(1);

    if (existing && existing.length > 0) {
      jaExistentes++;
      continue;
    }

    // Classificação inteligente baseada no destinatário
    const classificacao = classifyTransaction(tx.recipient, tx.rawBody);

    const row = {
      descricao: classificacao.descricao,
      valor: tx.amount,
      vencimento: date,
      status: 'realizado',
      data_pagamento: date,
      competencia,
      categoria: classificacao.categoria,
      classificacao: classificacao.classificacao,
      forma_pagamento: 'PIX',
      observacoes: `[${marker}] Importado automaticamente do C6 Bank`,
    };

    const { error } = await supabase
      .from('contas_pagar')
      .insert(row);

    if (!error) {
      sincronizadas++;
      valorTotal += tx.amount;
      contasCriadas.push({ descricao: classificacao.descricao, valor: tx.amount, categoria: classificacao.categoria });
    } else {
      console.error(`[SyncBank] Erro ao inserir conta: ${error.message}`);
    }
  }

  return JSON.stringify({
    sincronizadas,
    ja_existentes: jaExistentes,
    total_saidas: saidas.length,
    valor_total: valorTotal,
    contas_criadas: contasCriadas,
    mensagem: sincronizadas > 0
      ? `${sincronizadas} conta(s) criada(s) totalizando R$ ${valorTotal.toFixed(2)}`
      : jaExistentes > 0
        ? `Todas as ${jaExistentes} saída(s) já foram importadas anteriormente`
        : 'Nenhuma conta criada',
  });
}
