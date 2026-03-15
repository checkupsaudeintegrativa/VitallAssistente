import * as clinicorp from './clinicorp';
import * as db from './supabase';
import * as gcal from './google-calendar';
import * as gmail from './gmail';
import * as ponto from './ponto-report';
import * as evolution from './evolution';
import * as imageGen from './image-generator';
import * as ttsGen from './tts-generator';
import { UserConfig, GoogleCalendarConfig } from '../config/users';

// ── Sender phone (set por chatbot.ts antes de chatWithTools) ──

let _currentSenderPhone: string | null = null;

/** Define o telefone do sender atual (chamado antes de chatWithTools) */
export function setCurrentSenderPhone(phone: string): void {
  _currentSenderPhone = phone;
}

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
  'query_payments', 'get_financial_summary', 'query_budgets',
  'query_contas_pagar', 'create_conta_pagar', 'update_conta_pagar',
  'dar_baixa_conta', 'delete_conta_pagar', 'get_contas_summary',
  'sync_bank_transactions',
  'sync_bank_entradas',
  'sync_clinicorp_payments',
  'query_conta_corrente',
  'create_lancamento_cc',
  'update_lancamento_cc',
  'delete_lancamento_cc',
  'get_conta_corrente_summary',
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
      name: 'query_budgets',
      description: 'Consulta orçamentos (estimates) do Clinicorp num intervalo de datas. Retorna dados de todos os status: total de orçamentos, valor total, ticket médio, taxa de conversão. Use para "orçamentos do mês", "quanto tem em orçamento", "conversão de orçamentos".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
          group_by: { type: 'string', description: 'Agrupar por período. Use "month" para agrupar por mês. Omita para dados totais.' },
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
  // ── Importação de ENTRADAS bancárias (Gmail / C6 Bank) ──
  {
    type: 'function',
    function: {
      name: 'sync_bank_entradas',
      description: 'Busca entradas bancárias (PIX recebido, depósitos, créditos) do C6 Bank de uma data no Gmail e insere na conta corrente. Use para "importar entradas do banco", "sincronizar recebimentos", "puxar entradas".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  // ── Importação de vendas Clinicorp ──
  {
    type: 'function',
    function: {
      name: 'sync_clinicorp_payments',
      description: 'Busca pagamentos recebidos do Clinicorp (cartão, PIX, dinheiro) de uma data e insere na conta corrente como vendas. Use para "importar vendas do Clinicorp", "sincronizar recebimentos do sistema", "puxar pagamentos".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  // ── Conta Corrente (entradas bancárias + vendas Clinicorp) ──
  {
    type: 'function',
    function: {
      name: 'query_conta_corrente',
      description: 'Lista lançamentos da conta corrente (entradas bancárias e vendas) num intervalo de datas. Filtra por tipo (entrada/venda), categoria e contraparte. Use para "quanto entrou hoje", "vendas de ontem", "lançamentos da conta corrente".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
          tipo: { type: 'string', description: 'Filtrar por tipo: "entrada" (banco/PIX recebido) ou "venda" (Clinicorp). Opcional — sem filtro retorna ambos.' },
          categoria: { type: 'string', description: 'Filtrar por categoria (ex: "PIX CLINICORP", "CARTÃO CRÉDITO", "DEPÓSITO"). Opcional.' },
          contraparte: { type: 'string', description: 'Filtrar por contraparte/nome (ex: nome do paciente ou remetente). Opcional.' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_lancamento_cc',
      description: 'Cria um lançamento manual na conta corrente (entrada ou venda). Use quando o admin pedir para registrar uma entrada ou venda manualmente. Sempre confirme os dados antes de criar.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          hora: { type: 'string', description: 'Hora no formato HH:MM (opcional)' },
          tipo: { type: 'string', description: 'Tipo: "entrada" ou "venda"' },
          descricao: { type: 'string', description: 'Descrição do lançamento (ex: "PIX recebido de João", "Cartão crédito - Maria")' },
          contraparte: { type: 'string', description: 'Nome da contraparte (remetente ou paciente). Opcional.' },
          valor: { type: 'number', description: 'Valor em reais (ex: 500.00)' },
          categoria: { type: 'string', description: 'Categoria (ex: "PIX", "CARTÃO CRÉDITO", "DINHEIRO", "DEPÓSITO"). Opcional.' },
          observacoes: { type: 'string', description: 'Observações adicionais. Opcional.' },
        },
        required: ['data', 'tipo', 'descricao', 'valor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_lancamento_cc',
      description: 'Altera um lançamento existente da conta corrente. Sempre confirme as alterações com o usuário.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID do lançamento' },
          data: { type: 'string', description: 'Nova data YYYY-MM-DD. Opcional.' },
          hora: { type: 'string', description: 'Nova hora HH:MM. Opcional.' },
          tipo: { type: 'string', description: 'Novo tipo: "entrada" ou "venda". Opcional.' },
          descricao: { type: 'string', description: 'Nova descrição. Opcional.' },
          contraparte: { type: 'string', description: 'Nova contraparte. Opcional.' },
          valor: { type: 'number', description: 'Novo valor. Opcional.' },
          categoria: { type: 'string', description: 'Nova categoria. Opcional.' },
          observacoes: { type: 'string', description: 'Novas observações. Opcional.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_lancamento_cc',
      description: 'Exclui um lançamento da conta corrente. Sempre confirme com o usuário antes de excluir.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID do lançamento' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_conta_corrente_summary',
      description: 'Gera resumo da conta corrente num período, agrupado por tipo, categoria ou contraparte. Mostra totais separados de entradas vs vendas. Use para "resumo da conta corrente", "quanto entrou e quanto vendeu esse mês", "receita total do mês".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Data início no formato YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data fim no formato YYYY-MM-DD' },
          agrupar_por: { type: 'string', description: 'Agrupar por: "tipo" (default — entradas vs vendas), "categoria" ou "contraparte"' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  // ── Visualização: Gráficos, Cards, Áudio ──
  {
    type: 'function',
    function: {
      name: 'render_chart',
      description: 'Renderiza um GRÁFICO VISUAL (barras, linhas, pizza, rosca) e envia como IMAGEM no WhatsApp. SEMPRE use esta tool quando o usuário pedir "gráfico", "chart", "grafico de barras", "pizza", "evolução", ou qualquer visualização gráfica de dados. NÃO use render_card para gráficos — render_card é só para tabelas/resumos textuais.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Telefone de quem pediu (do [Contexto])' },
          chart_config: {
            type: 'object',
            description: `Config Chart.js. EXEMPLOS por tipo:

BARRAS: { "type": "bar", "data": { "labels": ["Lab","Impostos","Material"], "datasets": [{ "label": "Despesas (R$)", "data": [8400, 3200, 2150] }] }, "options": { "plugins": { "title": { "display": true, "text": "Despesas por Categoria" } } } }

PIZZA: { "type": "pie", "data": { "labels": ["PIX","Cartão","Dinheiro"], "datasets": [{ "data": [12000, 8500, 3200] }] }, "options": { "plugins": { "title": { "display": true, "text": "Receita por Forma de Pagamento" } } } }

LINHAS: { "type": "line", "data": { "labels": ["Seg","Ter","Qua","Qui","Sex"], "datasets": [{ "label": "Faturamento", "data": [3200, 4100, 2800, 5200, 3900], "fill": false, "tension": 0.3 }] }, "options": { "plugins": { "title": { "display": true, "text": "Faturamento da Semana" } } } }

ROSCA: { "type": "doughnut", "data": { "labels": ["Pago","Em aberto"], "datasets": [{ "data": [18500, 4200] }] }, "options": { "plugins": { "title": { "display": true, "text": "Status Contas a Pagar" } } } }`,
          },
          caption: { type: 'string', description: 'Legenda opcional da imagem' },
        },
        required: ['phone', 'chart_config'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_card',
      description: 'Renderiza um card visual (recibo, resumo, ficha) e envia como imagem no WhatsApp. Use para resumos compactos com pares label/valor. Exemplos: "resumo financeiro do dia", "recibo de pagamento", "ficha do paciente".',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Telefone de quem pediu (do [Contexto])' },
          title: { type: 'string', description: 'Título do card. Ex: "Resumo Financeiro - Março/2026"' },
          fields: {
            type: 'array',
            description: 'Lista de pares label/valor para exibir no card',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Rótulo do campo. Ex: "Total Receitas"' },
                value: { type: 'string', description: 'Valor do campo. Ex: "R$ 15.430,00"' },
              },
              required: ['label', 'value'],
            },
          },
          footer: { type: 'string', description: 'Texto de rodapé opcional. Ex: "Período: 01/03 a 15/03/2026"' },
          color: { type: 'string', description: 'Cor da barra do título em hex. Default: "#0d9488" (teal Vitall). Não precisa enviar a menos que queira uma cor diferente.' },
          caption: { type: 'string', description: 'Legenda opcional da imagem' },
        },
        required: ['phone', 'title', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_audio',
      description: 'Converte texto em áudio de voz no WhatsApp. O sistema divide textos longos em múltiplos áudios curtos automaticamente. Use PROATIVAMENTE quando a resposta for longa/complexa. REGRA CRUCIAL DO TEXTO: escreva EXATAMENTE como uma pessoa fala num áudio de WhatsApp — informal, direto, com pausas naturais (vírgulas, reticências). NUNCA escreva como relatório, documento ou lista. Imagine que você está mandando um áudio para um colega de trabalho. Exemplos: BOM: "Então cara, olhei aqui os números do mês e... tá indo bem, viu? A gente faturou quase dezesseis mil, o que é uns dois mil a mais que o mês passado. Só que tem um detalhe... os gastos com laboratório subiram bastante." RUIM: "O faturamento do mês foi de R$ 15.930,00, representando um aumento de 14% em relação ao mês anterior. As despesas com laboratório apresentaram elevação significativa." Não use asteriscos, bullets, números formatados (R$ 15.930,00) nem estrutura de texto. Fale os valores por extenso (quinze mil e novecentos). Use "né", "tipo", "olha", "então", "sabe" — linguagem natural brasileira.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Telefone de quem pediu (do [Contexto])' },
          text: { type: 'string', description: 'Texto para falar. Escreva de forma natural e conversacional, como se estivesse falando. Máximo ~2000 caracteres.' },
        },
        required: ['phone', 'text'],
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

/** Retorna data/hora atual em BRT como Date (use apenas para .toISOString().split('T')[0] ou display) */
function getBrtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

/** Retorna a data atual em BRT no formato YYYY-MM-DD (método mais seguro) */
function getBrtDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/** Valida que um valor monetário é finito e positivo */
function validateValor(valor: any): string | null {
  if (valor === undefined || valor === null) return 'Valor é obrigatório';
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'Valor inválido (não é um número)';
  if (n <= 0) return 'Valor deve ser positivo';
  return null;
}

/** Valida formato de data YYYY-MM-DD */
function validateDateStr(dateStr: any): string | null {
  if (!dateStr || typeof dateStr !== 'string') return 'Data é obrigatória';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return `Data "${dateStr}" não está no formato YYYY-MM-DD`;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return `Data "${dateStr}" é inválida`;
  }
  return null;
}

/** Valida tipo de lançamento da conta corrente */
const TIPOS_VALIDOS_CC = new Set(['entrada', 'venda']);

/** Arredonda valor monetário para 2 casas decimais */
function roundMoney(val: number): number {
  return Math.round(val * 100) / 100;
}

/** Safe toFixed que lida com valores potencialmente undefined */
function safeToFixed(val: any, decimals = 2): string {
  const n = Number(val);
  return Number.isFinite(n) ? n.toFixed(decimals) : '0.00';
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
  const found = toolDefinitions.filter((t) => nameSet.has(t.function.name));
  const foundNames = new Set(found.map((t) => t.function.name));
  for (const name of names) {
    if (!foundNames.has(name)) {
      console.warn(`[AI-Tools] Tool "${name}" listada no agente mas não encontrada nas definições`);
    }
  }
  return found;
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
  // Guard: apenas admin pode usar ferramentas financeiras (bloqueia se user ausente ou não-admin)
  if (FINANCIAL_TOOLS.has(name) && (!user || user.role !== 'admin')) {
    return JSON.stringify({
      error: 'Sem permissão',
      mensagem: `Você não tem acesso a informações financeiras. Fale com o Arthur ou a Dra. Ana para consultas financeiras.`,
    });
  }

  // Guard: apenas admin pode editar registros de ponto
  if (PONTO_EDIT_TOOLS.has(name) && (!user || user.role !== 'admin')) {
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

      case 'query_budgets':
        return executeQueryBudgets(args.date_from, args.date_to, args.group_by);

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

      case 'sync_bank_entradas':
        return executeSyncBankEntradas(args.date);

      case 'sync_clinicorp_payments':
        return executeSyncClinicorpPayments(args.date);

      // ── Conta Corrente ──
      case 'query_conta_corrente':
        return executeQueryContaCorrente(args.date_from, args.date_to, args.tipo, args.categoria, args.contraparte);

      case 'create_lancamento_cc':
        return executeCreateLancamentoCC(args);

      case 'update_lancamento_cc':
        return executeUpdateLancamentoCC(args);

      case 'delete_lancamento_cc':
        return executeDeleteLancamentoCC(args.id);

      case 'get_conta_corrente_summary':
        return executeGetContaCorrenteSummary(args.date_from, args.date_to, args.agrupar_por);

      // ── Visualização: Gráficos, Cards, Áudio ──
      case 'render_chart':
        return executeRenderChart(args.phone, args.chart_config, args.caption);

      case 'render_card':
        return executeRenderCard(args.phone, args.title, args.fields, args.footer, args.color, args.caption);

      case 'send_audio':
        return executeSendAudio(args.phone, args.text);

      default:
        return JSON.stringify({ error: `Ferramenta desconhecida: ${name}` });
    }
  } catch (error: any) {
    console.error(`[AI-Tools] Erro ao executar ${name}:`, error.message);
    return JSON.stringify({ error: `Erro ao executar a operação. Tente novamente ou entre em contato com o suporte.` });
  }
}

// ── Individual executors ──

function executeGetCurrentDatetime(): string {
  const brt = getBrtNow();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${brt.getFullYear()}-${pad(brt.getMonth() + 1)}-${pad(brt.getDate())}`;
  const time = `${pad(brt.getHours())}:${pad(brt.getMinutes())}`;
  const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  return JSON.stringify({
    agora_iso: `${date}T${time}:00-03:00`,
    date,
    time,
    weekday: weekdays[brt.getDay()],
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
  const allPayments = Array.isArray(raw) ? raw : [];
  // Filtrar pagamentos cancelados
  const payments = allPayments.filter((p: any) => p.Canceled !== 'X');

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

async function executeQueryBudgets(dateFrom: string, dateTo: string, groupBy?: string): Promise<string> {
  const raw = await clinicorp.listBudgets(dateFrom, dateTo, groupBy);
  const data = Array.isArray(raw) ? raw : [raw];
  return JSON.stringify({
    periodo: { de: dateFrom, ate: dateTo },
    agrupamento: groupBy || 'total',
    dados: data,
  });
}

async function executeCreateReminder(title: string, datetime: string, phone?: string, recurring?: boolean, user?: UserConfig | null, targetCalendar?: string): Promise<string> {
  const calConfig = resolveCalendarConfig(user, targetCalendar);
  const useCalendar = calConfig && gcal.isAvailable(calConfig);
  console.log(`[Reminder] user=${user?.name || 'null'}, calConfig=${JSON.stringify(calConfig)}, useCalendar=${useCalendar}, target=${targetCalendar || 'own'}`);

  // Helper: envia imagem de confirmação COM caption (fire-and-forget)
  const sendConfirmationImage = (targetPhone: string) => {
    console.log(`[Reminder] Gerando imagem de confirmação para ${targetPhone}...`);

    const caption = `> *Vitall:*\n\n✅ *Lembrete criado:* ${title}`;

    imageGen.renderReminderConfirmation(title, datetime)
      .then((buf) => {
        console.log(`[Reminder] Imagem gerada (${buf.length} bytes), enviando com caption...`);
        const b64 = buf.toString('base64');
        return evolution.sendImage(targetPhone, b64, caption);
      })
      .then((sent) => {
        console.log(`[Reminder] Imagem de confirmação enviada: ${sent}`);
      })
      .catch((err: any) => console.error('[Reminder] Erro ao enviar imagem de confirmação:', err.message, err.stack));
  };

  if (useCalendar) {
    const event = await gcal.createEvent(calConfig, {
      title,
      datetime,
      recurring: recurring || false,
    });

    if (event) {
      const resolvedPhone = phone || _currentSenderPhone || user?.phones?.[0];
      if (resolvedPhone) sendConfirmationImage(resolvedPhone);

      const remindDate = new Date(datetime);
      return JSON.stringify({
        sucesso: true,
        id: event.id,
        titulo: title,
        horario: remindDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        calendario: targetCalendar || undefined,
        recorrente: recurring || false,
        imagem_enviada: true,
        resposta_texto: '',
      });
    }

    return JSON.stringify({ sucesso: false, error: 'Não foi possível criar o lembrete' });
  }

  // Fallback → Supabase
  const result = await db.createReminder(title, datetime, phone, recurring);

  if (result) {
    const resolvedPhone = phone || _currentSenderPhone || user?.phones?.[0];
    if (resolvedPhone) sendConfirmationImage(resolvedPhone);

    const remindDate = new Date(datetime);
    return JSON.stringify({
      sucesso: true,
      id: result.id,
      titulo: title,
      horario: remindDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      telefone: phone || 'padrão',
      recorrente: recurring || false,
      imagem_enviada: true,
      resposta_texto: '',
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
  // V5: Validação de datas
  const errFrom = validateDateStr(dateFrom);
  const errTo = validateDateStr(dateTo);
  if (errFrom) return JSON.stringify({ error: `date_from: ${errFrom}` });
  if (errTo) return JSON.stringify({ error: `date_to: ${errTo}` });

  const { supabase } = await import('./supabase');

  let query = supabase
    .from('contas_pagar')
    .select('id, descricao, valor, vencimento, status, categoria, classificacao, competencia, forma_pagamento, data_pagamento')
    .gte('vencimento', dateFrom)
    .lte('vencimento', dateTo)
    .order('vencimento', { ascending: true })
    .limit(200);

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
    return JSON.stringify({ error: `Erro ao consultar contas a pagar` });
  }

  const contas = data || [];
  // V11: usar roundMoney para precisão
  const valorTotal = roundMoney(contas.reduce((sum: number, c: any) => sum + (c.valor || 0), 0));

  return JSON.stringify({
    total: contas.length,
    valor_total: valorTotal,
    aviso: contas.length >= 200 ? 'Limite de 200 registros atingido. Use filtros mais específicos.' : undefined,
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
  // V4: Validação monetária
  const valorErr = validateValor(args.valor);
  if (valorErr) return JSON.stringify({ error: valorErr });

  // V5: Validação de data
  const dateErr = validateDateStr(args.vencimento);
  if (dateErr) return JSON.stringify({ error: `vencimento: ${dateErr}` });

  if (!args.descricao || typeof args.descricao !== 'string' || !args.descricao.trim()) {
    return JSON.stringify({ error: 'Descrição é obrigatória' });
  }

  const { supabase } = await import('./supabase');

  // V16: competencia default = mês do vencimento (mantém mas documenta)
  const competencia = args.competencia || (args.vencimento ? args.vencimento.substring(0, 7) : undefined);

  const row: Record<string, any> = {
    descricao: args.descricao.trim(),
    valor: roundMoney(Number(args.valor)),
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
    return JSON.stringify({ error: `Erro ao criar conta a pagar` });
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
    mensagem: `Conta criada: "${data.descricao}" - R$ ${safeToFixed(data.valor)} vencimento ${data.vencimento}`,
  });
}

async function executeUpdateContaPagar(args: Record<string, any>): Promise<string> {
  const { supabase } = await import('./supabase');

  const { id, ...fields } = args;

  // V6: Campos protegidos - não podem ser alterados via update direto
  const PROTECTED_FIELDS = new Set(['status', 'data_pagamento', 'id', 'created_at', 'updated_at']);

  const updates: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined && val !== null && !PROTECTED_FIELDS.has(key)) updates[key] = val;
  }

  // V4: Validar valor se estiver sendo atualizado
  if (updates.valor !== undefined) {
    const valorErr = validateValor(updates.valor);
    if (valorErr) return JSON.stringify({ error: valorErr });
    updates.valor = roundMoney(Number(updates.valor));
  }

  // V5: Validar vencimento se estiver sendo atualizado
  if (updates.vencimento !== undefined) {
    const dateErr = validateDateStr(updates.vencimento);
    if (dateErr) return JSON.stringify({ error: `vencimento: ${dateErr}` });
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'Nenhum campo para atualizar informado (status e data_pagamento devem ser alterados via dar_baixa)' });
  }

  const { data, error } = await supabase
    .from('contas_pagar')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao atualizar conta` });
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

  // V10: Verificar se a conta existe e se já está paga
  const { data: conta, error: fetchErr } = await supabase
    .from('contas_pagar')
    .select('id, descricao, valor, status')
    .eq('id', id)
    .single();

  if (fetchErr || !conta) {
    return JSON.stringify({ error: `Conta não encontrada com o ID informado` });
  }

  if (conta.status === 'realizado') {
    return JSON.stringify({
      error: 'Conta já paga',
      mensagem: `A conta "${conta.descricao}" (R$ ${safeToFixed(conta.valor)}) já está marcada como paga.`,
    });
  }

  const hoje = getBrtDateStr();
  const dataPgto = dataPagamento || hoje;

  // V5: Validar data se informada
  if (dataPagamento) {
    const dateErr = validateDateStr(dataPagamento);
    if (dateErr) return JSON.stringify({ error: `data_pagamento: ${dateErr}` });
  }

  const { data, error } = await supabase
    .from('contas_pagar')
    .update({ status: 'realizado', data_pagamento: dataPgto })
    .eq('id', id)
    .eq('status', 'aberto') // Double check: só atualiza se ainda estiver aberto
    .select('id, descricao, valor')
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao dar baixa` });
  }

  return JSON.stringify({
    sucesso: true,
    id: data.id,
    mensagem: `Conta "${data.descricao}" (R$ ${safeToFixed(data.valor)}) marcada como paga em ${dataPgto}`,
  });
}

async function executeDeleteContaPagar(id: string): Promise<string> {
  const { supabase } = await import('./supabase');

  // V9: Verificar se a conta existe antes de excluir
  const { data: conta, error: fetchErr } = await supabase
    .from('contas_pagar')
    .select('id, descricao, valor, status')
    .eq('id', id)
    .single();

  if (fetchErr || !conta) {
    return JSON.stringify({ error: `Conta não encontrada com o ID "${id}"` });
  }

  // V17: Soft-delete — marca como excluído com timestamp em vez de deletar permanentemente
  const { error } = await supabase
    .from('contas_pagar')
    .update({
      status: 'excluido',
      observacoes: `${conta.status === 'realizado' ? '[PAGO] ' : ''}Excluído em ${getBrtDateStr()} | ${(conta as any).observacoes || ''}`.trim(),
    })
    .eq('id', id);

  if (error) {
    // Fallback: se soft-delete falhar (ex: constraint), tentar hard delete
    const { error: delErr } = await supabase
      .from('contas_pagar')
      .delete()
      .eq('id', id);

    if (delErr) {
      return JSON.stringify({ error: `Erro ao excluir conta` });
    }
  }

  return JSON.stringify({
    sucesso: true,
    id,
    mensagem: `Conta "${conta.descricao}" (R$ ${safeToFixed(conta.valor)}) excluída`,
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
    return JSON.stringify({ error: `Erro ao gerar resumo` });
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

  // V11: Arredondar totais para precisão monetária
  const grupos = Object.entries(grupoMap)
    .map(([nome, info]) => ({ nome, total: roundMoney(info.total), quantidade: info.quantidade }))
    .sort((a, b) => b.total - a.total);

  return JSON.stringify({
    periodo: `${dateFrom} a ${dateTo}`,
    total_contas: contas.length,
    total_geral: roundMoney(totalGeral),
    total_aberto: roundMoney(totalAberto),
    total_realizado: roundMoney(totalRealizado),
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

/** V15: Detecta forma de pagamento pelo conteúdo do email C6 Bank */
function detectFormaPagamento(emailSubject: string, rawBody: string): string {
  const text = `${emailSubject}\n${rawBody}`.toLowerCase();
  if (text.includes('boleto')) return 'BOLETO';
  if (text.includes('ted') || text.includes('transferência') || text.includes('transferencia')) return 'TED';
  if (text.includes('débito') || text.includes('debito') || text.includes('debit')) return 'CARTÃO DÉBITO';
  if (text.includes('pix')) return 'PIX';
  return 'PIX'; // Fallback: C6 Bank saídas são predominantemente PIX
}

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

  // V2: Batch dedup — busca todos os markers de uma vez para minimizar race condition
  const { data: existingContas } = await supabase
    .from('contas_pagar')
    .select('observacoes')
    .not('observacoes', 'is', null)
    .like('observacoes', '%gmail:%')
    .limit(5000);

  const existingMarkers = new Set<string>();
  if (existingContas) {
    for (const c of existingContas) {
      const match = (c.observacoes || '').match(/gmail:([^\]\s]+)/);
      if (match) existingMarkers.add(match[0]);
    }
  }

  for (const tx of saidas) {
    const marker = `gmail:${tx.emailMessageId}`;
    if (existingMarkers.has(marker)) {
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
      // V15: Detectar forma de pagamento pelo conteúdo do email
      forma_pagamento: detectFormaPagamento(tx.emailSubject, tx.rawBody),
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

// ── Classificação de entradas bancárias ──

interface EntradaClassificacao {
  descricao: string;
  categoria: string;
}

function classifyEntrada(recipient: string, rawBody: string): EntradaClassificacao {
  const fullText = `${recipient}\n${rawBody}`.toLowerCase();

  if (fullText.includes('pix recebido') || fullText.includes('recebid')) {
    const shortName = recipient
      ? recipient.split(/\s+/).slice(0, 3).join(' ')
      : 'N/I';
    return { descricao: `PIX recebido de ${shortName}`, categoria: 'PIX RECEBIDO' };
  }

  if (fullText.includes('recebimentos agendados') || fullText.includes('recebíveis') || fullText.includes('recebiveis')) {
    return { descricao: 'Recebíveis cartão de crédito', categoria: 'RECEBÍVEIS CARTÃO' };
  }

  if (fullText.includes('depósito') || fullText.includes('deposito')) {
    return { descricao: `Depósito recebido`, categoria: 'DEPÓSITO' };
  }

  if (fullText.includes('crédito') || fullText.includes('credito')) {
    return { descricao: `Crédito recebido`, categoria: 'CRÉDITO' };
  }

  const shortName = recipient
    ? recipient.split(/\s+/).slice(0, 3).join(' ')
    : 'N/I';
  return { descricao: `Entrada bancária de ${shortName}`, categoria: 'BANCO' };
}

// ── Dia útil: recebíveis de cartão só entram em dias úteis ──

/** Retorna true se a data (YYYY-MM-DD) é dia útil (seg-sex, sem feriados nacionais fixos) */
function isBusinessDay(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=dom, 6=sab
  if (dow === 0 || dow === 6) return false;

  // Feriados nacionais fixos (MM-DD)
  const mmdd = dateStr.substring(5); // "MM-DD"
  const feriadosFixos = [
    '01-01', // Confraternização
    '04-21', // Tiradentes
    '05-01', // Dia do Trabalho
    '09-07', // Independência
    '10-12', // Nossa Senhora
    '11-02', // Finados
    '11-15', // Proclamação da República
    '12-25', // Natal
  ];
  if (feriadosFixos.includes(mmdd)) return false;

  return true;
}

/** Retorna o próximo dia útil a partir de dateStr (inclusive). Se já for dia útil, retorna ele mesmo. */
function getDepositDate(dateStr: string): string {
  let d = new Date(dateStr + 'T12:00:00');
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().substring(0, 10);
    if (isBusinessDay(iso)) return iso;
    d.setDate(d.getDate() + 1);
  }
  return dateStr; // fallback
}

// ── Sync entradas bancárias (Gmail → lancamentos_conta_corrente) ──

async function executeSyncBankEntradas(date: string): Promise<string> {
  const { supabase } = await import('./supabase');

  let sincronizadas = 0;
  let jaExistentes = 0;
  let valorTotal = 0;
  const lancamentosCriados: Array<{ descricao: string; valor: number; categoria: string; contraparte: string }> = [];

  // V2: Batch dedup — busca todos os markers existentes de uma vez
  const { data: existingLancamentos } = await supabase
    .from('lancamentos_conta_corrente')
    .select('observacoes')
    .not('observacoes', 'is', null)
    .limit(5000);

  const existingLCMarkers = new Set<string>();
  if (existingLancamentos) {
    for (const l of existingLancamentos) {
      const obs = l.observacoes || '';
      const gmailMatch = obs.match(/gmail:([^\]\s]+)/);
      if (gmailMatch) existingLCMarkers.add(gmailMatch[0]);
      const nsuMatch = obs.match(/c6_recebivel:([^\]\s]+)/);
      if (nsuMatch) existingLCMarkers.add(nsuMatch[0]);
    }
  }

  let hasCardFromGmail = false;
  let gmailCardTx: gmail.BankTransaction | null = null;
  let detalhesExcel = false;
  let fallbackMotivo = '';

  // ── 1) Entradas do Gmail (PIX, depósitos; detecta cartão para etapa 2) ──
  if (gmail.isAvailable()) {
    let transactions;
    try {
      transactions = await gmail.fetchC6BankTransactions(date);
    } catch (err: any) {
      console.error(`[SyncBankEntradas] Erro ao buscar emails do Gmail: ${err.message}`);
    }

    if (transactions) {
      const entradas = transactions.filter((t) => t.type === 'entrada');
      for (const tx of entradas) {
        const classificacao = classifyEntrada(tx.recipient, tx.rawBody);
        // Separar entradas de cartão — serão detalhadas na etapa 2
        if (classificacao.categoria === 'RECEBÍVEIS CARTÃO' || classificacao.categoria === 'CRÉDITO') {
          hasCardFromGmail = true;
          gmailCardTx = tx;
          continue;
        }

        const marker = `gmail:${tx.emailMessageId}`;
        if (existingLCMarkers.has(marker)) {
          jaExistentes++;
          continue;
        }

        const row = {
          data: date,
          hora: null,
          tipo: 'entrada',
          descricao: classificacao.descricao,
          contraparte: tx.recipient || null,
          valor: tx.amount,
          categoria: classificacao.categoria,
          observacoes: `[${marker}] Importado automaticamente do C6 Bank`,
        };

        const { error } = await supabase
          .from('lancamentos_conta_corrente')
          .insert(row);

        if (!error) {
          sincronizadas++;
          valorTotal += tx.amount;
          lancamentosCriados.push({ descricao: classificacao.descricao, valor: tx.amount, categoria: classificacao.categoria, contraparte: tx.recipient || '' });
        } else {
          console.error(`[SyncBankEntradas] Erro ao inserir lançamento Gmail: ${error.message}`);
        }
      }
    }
  }

  // ── 2) Entradas de cartão: Excel (parcelas) + Clinicorp (paciente) ──
  // Recebíveis de cartão só entram em dia útil
  const depositDate = getDepositDate(date);
  if (depositDate !== date) {
    console.log(`[SyncBankEntradas] ${date} não é dia útil. Recebíveis de cartão entrarão em ${depositDate}`);
  }

  if (hasCardFromGmail) {
    let cardImported = false;

    // 2a) Tentar extrair parcelas do Excel anexo do C6 Bank
    let recebiveis: gmail.RecebívelParcela[] = [];
    try {
      recebiveis = await gmail.fetchRecebiveis(date);
      if (recebiveis.length === 0) {
        fallbackMotivo = 'Excel não encontrado ou sem parcelas';
      }
    } catch (err: any) {
      console.warn(`[SyncBankEntradas] Erro ao extrair Excel recebíveis: ${err.message}`);
      fallbackMotivo = `Erro Excel: ${err.message}`;
    }

    if (recebiveis.length > 0) {
      detalhesExcel = true;
      // 2b) Buscar pagamentos cartão do Clinicorp para cruzar nome do paciente
      let clinicorpCards: any[] = [];
      try {
        const raw = await clinicorp.listPayments(date, date);
        const payments = Array.isArray(raw) ? raw : [];
        clinicorpCards = payments.filter((p: any) =>
          p.PaymentReceived === 'X' &&
          p.Canceled !== 'X' &&
          (p.Type?.includes('CREDIT_CARD') || p.Type?.includes('DEBIT_CARD'))
        );
      } catch (err: any) {
        console.warn(`[SyncBankEntradas] Clinicorp indisponível para cruzamento: ${err.message}`);
      }

      // Matching: para cada parcela do Excel, encontrar paciente no Clinicorp pelo valor bruto
      const usedClinicorpIds = new Set<string>();

      for (const rec of recebiveis) {
        const nsuMarker = `c6_recebivel:${rec.nsu}_${rec.parcela}`;
        if (existingLCMarkers.has(nsuMarker)) {
          jaExistentes++;
          continue;
        }

        // Encontrar paciente pelo valor bruto
        let patientName = '';
        const matchIdx = clinicorpCards.findIndex((p: any) => {
          const pid = String(p.id || p.PaymentHeaderId || '');
          if (usedClinicorpIds.has(pid)) return false;
          return Math.abs(Number(p.Amount || 0) - rec.valorBruto) < 0.01;
        });
        if (matchIdx >= 0) {
          const match = clinicorpCards[matchIdx];
          patientName = (match.PatientName || '').replace(/\s*\(\d+\)$/, '');
          usedClinicorpIds.add(String(match.id || match.PaymentHeaderId || ''));
        }

        const categoria = rec.tipo.toLowerCase().includes('déb') ? 'CARTÃO DÉBITO' : 'CARTÃO CRÉDITO';
        const parcelaInfo = rec.parcela !== '1/1' ? ` (${rec.parcela})` : '';
        const descricao = patientName
          ? `${rec.bandeira} ${rec.tipo}${parcelaInfo} - ${patientName}`
          : `${rec.bandeira} ${rec.tipo}${parcelaInfo}`;

        const row = {
          data: depositDate,
          hora: null,
          tipo: 'entrada',
          descricao,
          contraparte: patientName || null,
          valor: rec.valorLiquido,
          categoria,
          observacoes: `[${nsuMarker}] Bruto: R$ ${rec.valorBruto.toFixed(2)} | Taxa: R$ ${rec.taxa.toFixed(2)} | NSU: ${rec.nsu}`,
        };

        const { error } = await supabase
          .from('lancamentos_conta_corrente')
          .insert(row);

        if (!error) {
          sincronizadas++;
          valorTotal += rec.valorLiquido;
          lancamentosCriados.push({ descricao, valor: rec.valorLiquido, categoria, contraparte: patientName });
          cardImported = true;
        } else {
          console.error(`[SyncBankEntradas] Erro ao inserir recebível: ${error.message}`);
        }
      }
    }

    // 2c) Fallback: se não conseguiu via Excel, usar Gmail genérico
    if (!cardImported && gmailCardTx) {
      const marker = `gmail:${gmailCardTx.emailMessageId}`;
      if (existingLCMarkers.has(marker)) {
        jaExistentes++;
      } else {
        const classificacao = classifyEntrada(gmailCardTx.recipient, gmailCardTx.rawBody);

        // Extrair valor líquido do email (pós taxas da maquininha)
        // O email diz "Valor líquido das vendas (pós taxas): R$ 297,54"
        const netMatch = gmailCardTx.rawBody.match(/valor\s+l[ií]quido[^R]*R\$\s*([\d.,]+)/i);
        const valorFallback = netMatch
          ? parseFloat(netMatch[1].replace(/\./g, '').replace(',', '.'))
          : gmailCardTx.amount;
        if (netMatch) {
          console.log(`[SyncBankEntradas] Fallback: valor líquido R$ ${valorFallback.toFixed(2)} (bruto: R$ ${gmailCardTx.amount.toFixed(2)})`);
        }

        const row = {
          data: depositDate,
          hora: null,
          tipo: 'entrada',
          descricao: classificacao.descricao,
          contraparte: gmailCardTx.recipient || null,
          valor: valorFallback,
          categoria: classificacao.categoria,
          observacoes: `[${marker}] Bruto: R$ ${gmailCardTx.amount.toFixed(2)} | Líquido: R$ ${valorFallback.toFixed(2)} | Importado do C6 Bank (fallback)`,
        };

        const { error } = await supabase.from('lancamentos_conta_corrente').insert(row);
        if (!error) {
          sincronizadas++;
          valorTotal += valorFallback;
          lancamentosCriados.push({ descricao: classificacao.descricao, valor: valorFallback, categoria: classificacao.categoria, contraparte: '' });
          console.log(`[SyncBankEntradas] Fallback Gmail para cartão: R$ ${valorFallback.toFixed(2)}`);
        }
      }
    }
  }

  const depositInfo = depositDate !== date ? ` (depósito em ${depositDate} — próximo dia útil)` : '';
  return JSON.stringify({
    sincronizadas,
    ja_existentes: jaExistentes,
    valor_total: valorTotal,
    data_deposito_cartao: depositDate !== date ? depositDate : undefined,
    detalhes_excel: detalhesExcel,
    fallback_motivo: !detalhesExcel && hasCardFromGmail ? (fallbackMotivo || 'Usado fallback Gmail') : undefined,
    lancamentos_criados: lancamentosCriados,
    mensagem: sincronizadas > 0
      ? `${sincronizadas} entrada(s) importada(s) totalizando R$ ${valorTotal.toFixed(2)}${detalhesExcel ? ' (com parcelas detalhadas do Excel)' : ''}${depositInfo}`
      : jaExistentes > 0
        ? `Todas as ${jaExistentes} entrada(s) já foram importadas anteriormente`
        : 'Nenhuma entrada importada',
  });
}

// ── Mapeamento de tipo de pagamento Clinicorp ──

function mapClinicorpPaymentType(type: string): string {
  if (!type) return 'OUTROS';
  const lower = type.toLowerCase();

  // V21: Checar débito ANTES de crédito para evitar falso match em strings mistas
  if (lower.includes('debit') || lower.includes('débito') || lower.includes('debito')) {
    return 'CARTÃO DÉBITO';
  }
  if (lower.includes('credit') || lower.includes('crédito') || lower.includes('credito')) {
    return 'CARTÃO CRÉDITO';
  }
  if (lower.includes('pix')) return 'PIX CLINICORP';
  if (lower.includes('cash') || lower.includes('dinheiro') || lower.includes('espécie')) return 'DINHEIRO';
  if (lower.includes('boleto')) return 'BOLETO';
  if (lower.includes('transfer') || lower.includes('transferência')) return 'TRANSFERÊNCIA';

  return type.toUpperCase();
}

// ── Sync vendas Clinicorp (API → lancamentos_conta_corrente) ──

async function executeSyncClinicorpPayments(date: string): Promise<string> {
  let raw: any;
  try {
    raw = await clinicorp.listFinancialSummary(date, date);
  } catch (err: any) {
    console.error(`[SyncClinicorp] Erro ao buscar resumo financeiro: ${err.message}`);
    return JSON.stringify({
      error: 'Erro ao acessar Clinicorp',
      mensagem: `Não foi possível acessar o Clinicorp: ${err.message}`,
    });
  }

  const allEntries = raw?.values || [];
  // REVENUE + PATIENT_AP = "Lançamento de Tratamento" (vendas reais)
  const vendas = allEntries.filter((v: any) => v.PostType === 'REVENUE');

  if (vendas.length === 0) {
    return JSON.stringify({
      sincronizadas: 0,
      ja_existentes: 0,
      total_pagamentos: 0,
      valor_total: 0,
      mensagem: `Nenhuma venda (Lançamento de Tratamento) encontrada no Clinicorp para ${date}`,
    });
  }

  const { supabase } = await import('./supabase');

  let sincronizadas = 0;
  let jaExistentes = 0;
  let valorTotal = 0;
  const lancamentosCriados: Array<{ descricao: string; valor: number; categoria: string; contraparte: string }> = [];

  for (const v of vendas) {
    const entryId = String(v.id || '');
    if (!entryId) continue;

    // Dedup: verificar se já existe lançamento com esse clinicorp ID
    const marker = `clinicorp_venda:${entryId}`;
    const { data: existing } = await supabase
      .from('lancamentos_conta_corrente')
      .select('id')
      .ilike('observacoes', `%${marker}%`)
      .limit(1);

    if (existing && existing.length > 0) {
      jaExistentes++;
      continue;
    }

    const patientName = v.PatientName || v.PersonName || 'Paciente';
    const amount = Math.abs(Number(v.Amount || 0));
    if (amount <= 0) continue;

    const descricao = `Lançamento de Tratamento - ${patientName}`;

    const row = {
      data: date,
      hora: null,
      tipo: 'venda',
      descricao,
      contraparte: patientName,
      valor: amount,
      categoria: 'TRATAMENTO',
      observacoes: `[${marker}] Importado automaticamente do Clinicorp`,
    };

    const { error } = await supabase
      .from('lancamentos_conta_corrente')
      .insert(row);

    if (!error) {
      sincronizadas++;
      valorTotal += amount;
      lancamentosCriados.push({ descricao, valor: amount, categoria: 'TRATAMENTO', contraparte: patientName });
    } else {
      console.error(`[SyncClinicorp] Erro ao inserir lançamento: ${error.message}`);
    }
  }

  return JSON.stringify({
    sincronizadas,
    ja_existentes: jaExistentes,
    total_pagamentos: vendas.length,
    valor_total: valorTotal,
    lancamentos_criados: lancamentosCriados,
    mensagem: sincronizadas > 0
      ? `${sincronizadas} venda(s) importada(s) do Clinicorp totalizando R$ ${valorTotal.toFixed(2)}`
      : jaExistentes > 0
        ? `Todas as ${jaExistentes} venda(s) já foram importadas anteriormente`
        : 'Nenhuma venda importada',
  });
}

// ── Conta Corrente CRUD ──

async function executeQueryContaCorrente(
  dateFrom: string,
  dateTo: string,
  tipo?: string,
  categoria?: string,
  contraparte?: string,
): Promise<string> {
  // V5: Validação de datas
  const errFrom = validateDateStr(dateFrom);
  const errTo = validateDateStr(dateTo);
  if (errFrom) return JSON.stringify({ error: `date_from: ${errFrom}` });
  if (errTo) return JSON.stringify({ error: `date_to: ${errTo}` });

  const { supabase } = await import('./supabase');

  let query = supabase
    .from('lancamentos_conta_corrente')
    .select('id, data, hora, tipo, descricao, contraparte, valor, categoria, observacoes')
    .gte('data', dateFrom)
    .lte('data', dateTo)
    .order('data', { ascending: true })
    .limit(200);

  if (tipo) {
    query = query.eq('tipo', tipo);
  }
  if (categoria) {
    query = query.ilike('categoria', `%${categoria}%`);
  }
  if (contraparte) {
    query = query.ilike('contraparte', `%${contraparte}%`);
  }

  const { data, error } = await query;
  if (error) {
    return JSON.stringify({ error: `Erro ao consultar conta corrente: ${error.message}` });
  }

  const lancamentos = data || [];
  const valorTotal = roundMoney(lancamentos.reduce((sum: number, l: any) => sum + (l.valor || 0), 0));

  return JSON.stringify({
    total: lancamentos.length,
    valor_total: valorTotal,
    aviso: lancamentos.length >= 200 ? 'Limite de 200 registros atingido. Use filtros mais específicos.' : undefined,
    lancamentos: lancamentos.map((l: any) => ({
      id: l.id,
      data: l.data,
      tipo: l.tipo,
      descricao: l.descricao,
      contraparte: l.contraparte || '',
      valor: l.valor,
      categoria: l.categoria || '',
    })),
  });
}

async function executeCreateLancamentoCC(args: Record<string, any>): Promise<string> {
  // V4: Validação monetária
  const valorErr = validateValor(args.valor);
  if (valorErr) return JSON.stringify({ error: valorErr });

  // V5: Validação de data
  const dateErr = validateDateStr(args.data);
  if (dateErr) return JSON.stringify({ error: `data: ${dateErr}` });

  // V8: Validação de tipo
  if (!args.tipo || !TIPOS_VALIDOS_CC.has(args.tipo)) {
    return JSON.stringify({ error: `Tipo deve ser "entrada" ou "venda". Recebido: "${args.tipo}"` });
  }

  if (!args.descricao || typeof args.descricao !== 'string' || !args.descricao.trim()) {
    return JSON.stringify({ error: 'Descrição é obrigatória' });
  }

  const { supabase } = await import('./supabase');

  const row: Record<string, any> = {
    data: args.data,
    tipo: args.tipo,
    descricao: args.descricao.trim(),
    valor: roundMoney(Number(args.valor)),
  };
  if (args.hora) row.hora = args.hora;
  if (args.contraparte) row.contraparte = args.contraparte;
  if (args.categoria) row.categoria = args.categoria;
  if (args.observacoes) row.observacoes = args.observacoes;

  const { data, error } = await supabase
    .from('lancamentos_conta_corrente')
    .insert(row)
    .select()
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao criar lançamento` });
  }

  return JSON.stringify({
    sucesso: true,
    lancamento: {
      id: data.id,
      data: data.data,
      tipo: data.tipo,
      descricao: data.descricao,
      valor: data.valor,
      categoria: data.categoria || '',
    },
    mensagem: `Lançamento criado: "${data.descricao}" - R$ ${safeToFixed(data.valor)} em ${data.data}`,
  });
}

async function executeUpdateLancamentoCC(args: Record<string, any>): Promise<string> {
  const { supabase } = await import('./supabase');

  const { id, ...fields } = args;
  const PROTECTED_FIELDS = new Set(['id', 'created_at', 'updated_at']);
  const updates: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined && val !== null && !PROTECTED_FIELDS.has(key)) updates[key] = val;
  }

  // Validações
  if (updates.valor !== undefined) {
    const valorErr = validateValor(updates.valor);
    if (valorErr) return JSON.stringify({ error: valorErr });
    updates.valor = roundMoney(Number(updates.valor));
  }
  if (updates.data !== undefined) {
    const dateErr = validateDateStr(updates.data);
    if (dateErr) return JSON.stringify({ error: `data: ${dateErr}` });
  }
  if (updates.tipo !== undefined && !TIPOS_VALIDOS_CC.has(updates.tipo)) {
    return JSON.stringify({ error: `Tipo deve ser "entrada" ou "venda"` });
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'Nenhum campo para atualizar informado' });
  }

  const { data, error } = await supabase
    .from('lancamentos_conta_corrente')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return JSON.stringify({ error: `Erro ao atualizar lançamento` });
  }

  return JSON.stringify({
    sucesso: true,
    lancamento: {
      id: data.id,
      data: data.data,
      tipo: data.tipo,
      descricao: data.descricao,
      valor: data.valor,
      categoria: data.categoria || '',
    },
    mensagem: `Lançamento "${data.descricao}" atualizado com sucesso`,
  });
}

async function executeDeleteLancamentoCC(id: string): Promise<string> {
  const { supabase } = await import('./supabase');

  // V9: Verificar se existe antes de deletar
  const { data: lancamento, error: fetchErr } = await supabase
    .from('lancamentos_conta_corrente')
    .select('id, descricao, valor')
    .eq('id', id)
    .single();

  if (fetchErr || !lancamento) {
    return JSON.stringify({ error: `Lançamento não encontrado com o ID "${id}"` });
  }

  const { error } = await supabase
    .from('lancamentos_conta_corrente')
    .delete()
    .eq('id', id);

  if (error) {
    return JSON.stringify({ error: `Erro ao excluir lançamento` });
  }

  return JSON.stringify({
    sucesso: true,
    id,
    mensagem: `Lançamento "${lancamento.descricao}" (R$ ${safeToFixed(lancamento.valor)}) excluído`,
  });
}

async function executeGetContaCorrenteSummary(
  dateFrom: string,
  dateTo: string,
  agruparPor?: string,
): Promise<string> {
  const { supabase } = await import('./supabase');

  const groupField = agruparPor === 'categoria' ? 'categoria'
    : agruparPor === 'contraparte' ? 'contraparte'
    : 'tipo';

  const { data, error } = await supabase
    .from('lancamentos_conta_corrente')
    .select('valor, tipo, categoria, contraparte')
    .gte('data', dateFrom)
    .lte('data', dateTo);

  if (error) {
    return JSON.stringify({ error: `Erro ao gerar resumo` });
  }

  const lancamentos = data || [];
  let totalGeral = 0;
  let totalEntradas = 0;
  let totalVendas = 0;

  const grupoMap: Record<string, { total: number; quantidade: number }> = {};

  for (const l of lancamentos) {
    const valor = l.valor || 0;
    totalGeral += valor;
    if (l.tipo === 'entrada') totalEntradas += valor;
    if (l.tipo === 'venda') totalVendas += valor;

    const grupoKey = (l[groupField as keyof typeof l] as string) || 'Sem classificação';
    if (!grupoMap[grupoKey]) grupoMap[grupoKey] = { total: 0, quantidade: 0 };
    grupoMap[grupoKey].total += valor;
    grupoMap[grupoKey].quantidade++;
  }

  // V11: Arredondar totais para precisão monetária
  const grupos = Object.entries(grupoMap)
    .map(([nome, info]) => ({ nome, total: roundMoney(info.total), quantidade: info.quantidade }))
    .sort((a, b) => b.total - a.total);

  return JSON.stringify({
    periodo: `${dateFrom} a ${dateTo}`,
    total_lancamentos: lancamentos.length,
    total_geral: roundMoney(totalGeral),
    total_entradas: roundMoney(totalEntradas),
    total_vendas: roundMoney(totalVendas),
    agrupado_por: groupField,
    grupos,
  });
}

// ── Visualização: Gráficos, Cards, Áudio ──

async function executeRenderChart(phone: string, chartConfig: any, caption?: string): Promise<string> {
  if (!phone) return JSON.stringify({ error: 'Parâmetro phone é obrigatório' });
  if (!chartConfig || !chartConfig.type || !chartConfig.data) {
    return JSON.stringify({ error: 'chart_config deve ter type e data' });
  }

  try {
    const buffer = await imageGen.renderChart(chartConfig);
    const base64 = buffer.toString('base64');
    const sent = await evolution.sendImage(phone, base64, caption);
    return JSON.stringify({
      sucesso: sent,
      mensagem: sent ? 'Gráfico enviado com sucesso' : 'Erro ao enviar gráfico',
    });
  } catch (err: any) {
    console.error('[AI-Tools] Erro ao renderizar gráfico:', err.message);
    return JSON.stringify({ error: 'Erro ao gerar gráfico: ' + err.message });
  }
}

async function executeRenderCard(
  phone: string,
  title: string,
  fields: Array<{ label: string; value: string }>,
  footer?: string,
  color?: string,
  caption?: string,
): Promise<string> {
  if (!phone) return JSON.stringify({ error: 'Parâmetro phone é obrigatório' });
  if (!title) return JSON.stringify({ error: 'Parâmetro title é obrigatório' });
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return JSON.stringify({ error: 'fields deve ser um array não-vazio de { label, value }' });
  }

  try {
    const buffer = await imageGen.renderCard({ title, fields, footer, color });
    const base64 = buffer.toString('base64');
    const sent = await evolution.sendImage(phone, base64, caption);
    return JSON.stringify({
      sucesso: sent,
      mensagem: sent ? 'Card enviado com sucesso' : 'Erro ao enviar card',
    });
  } catch (err: any) {
    console.error('[AI-Tools] Erro ao renderizar card:', err.message);
    return JSON.stringify({ error: 'Erro ao gerar card: ' + err.message });
  }
}

async function executeSendAudio(phone: string, text: string): Promise<string> {
  if (!phone) return JSON.stringify({ error: 'Parâmetro phone é obrigatório' });
  if (!text) return JSON.stringify({ error: 'Parâmetro text é obrigatório' });

  // Limpar qualquer formatação markdown que a IA tenha deixado escapar
  const cleanText = stripMarkdownForSpeech(text);

  // Trocar presença para "gravando áudio..." (usa o loop existente do chatbot, sem criar novo)
  const presence = evolution.getPresenceController(phone);
  if (presence) presence.setMode('recording');

  try {
    // Dividir texto longo em partes de ~500 chars (cada áudio fica ~30-45s)
    const chunks = splitTextForAudio(cleanText);

    for (let i = 0; i < chunks.length; i++) {
      const buffer = await ttsGen.generateAudio(chunks[i]);
      const base64 = buffer.toString('base64');
      await evolution.sendAudio(phone, base64);
    }

    // Só volta para "digitando..." DEPOIS de todos os áudios enviados
    if (presence) presence.setMode('composing');

    return JSON.stringify({
      sucesso: true,
      mensagem: chunks.length > 1
        ? `${chunks.length} áudios enviados com sucesso`
        : 'Áudio enviado com sucesso',
    });
  } catch (err: any) {
    if (presence) presence.setMode('composing');
    console.error('[AI-Tools] Erro ao gerar áudio TTS:', err.message);
    return JSON.stringify({ error: 'Erro ao gerar áudio: ' + err.message });
  }
}

/** Remove formatação markdown/WhatsApp do texto para que o TTS não fale "asterisco" */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*/g, '')          // **negrito** markdown
    .replace(/\*/g, '')            // *negrito* WhatsApp
    .replace(/_([^_]+)_/g, '$1')   // _itálico_
    .replace(/~([^~]+)~/g, '$1')   // ~riscado~
    .replace(/```[^`]*```/g, '')   // blocos de código
    .replace(/`([^`]+)`/g, '$1')   // código inline
    .replace(/^#+\s*/gm, '')       // # títulos markdown
    .replace(/^[-•]\s*/gm, '')     // - bullets
    .replace(/^\d+\.\s*/gm, '')    // 1. listas numeradas
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url)
    .replace(/R\$\s?([\d.,]+)/g, (_, v) => convertCurrencyToWords(v)) // R$ 15.430,00 → por extenso
    .replace(/\bDra\.\s?/gi, 'Doutora ')  // Dra. → Doutora (TTS)
    .replace(/\bDr\.\s?/gi, 'Doutor ')    // Dr. → Doutor (TTS)
    .replace(/\n{3,}/g, '\n\n')    // múltiplas quebras
    .trim();
}

/** Converte valor monetário para palavras aproximadas */
function convertCurrencyToWords(value: string): string {
  const num = parseFloat(value.replace(/\./g, '').replace(',', '.'));
  if (isNaN(num)) return value + ' reais';
  if (num >= 1000) {
    const mil = Math.floor(num / 1000);
    const rest = Math.round(num % 1000);
    if (rest === 0) return `${mil} mil reais`;
    if (rest < 100) return `${mil} mil e ${rest} reais`;
    return `${mil} mil e ${rest} reais`;
  }
  return `${Math.round(num)} reais`;
}

/** Divide texto em partes de no máximo ~500 chars, quebrando em parágrafos ou frases */
function splitTextForAudio(text: string, maxChars = 500): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  // Primeiro tenta dividir por parágrafos (dupla quebra de linha)
  const paragraphs = text.split(/\n\n+/);

  let current = '';
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > maxChars) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Se algum chunk ainda é muito longo, divide por frases
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of sentences) {
        if (buf && (buf.length + s.length + 1) > maxChars) {
          result.push(buf.trim());
          buf = s;
        } else {
          buf = buf ? buf + ' ' + s : s;
        }
      }
      if (buf.trim()) result.push(buf.trim());
    }
  }

  return result;
}
