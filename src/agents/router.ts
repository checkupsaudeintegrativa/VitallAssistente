import { AgentId, RouterResult } from './types';

/** Keywords por agente para classificação de intent */
const INTENT_KEYWORDS: Record<Exclude<AgentId, 'geral'>, string[]> = {
  agenda: [
    'agenda', 'agendamento', 'agendamentos', 'consulta', 'consultas',
    'horario', 'horários', 'horarios',
    'quantos pacientes', 'quantas pacientes', 'paciente',
    'aniversariante', 'aniversário', 'aniversario', 'aniversariantes',
    'revisão', 'revisao', 'revisões', 'revisoes',
    'cirurgia', 'cirurgias',
    'botox', 'harmonização', 'harmonizacao', 'clareamento',
    'ortodontia', 'aparelho',
    'procedimento', 'procedimentos',
    'quem atende', 'próximo paciente', 'proximo paciente',
    'agenda da dra', 'agenda do dr', 'agenda de amanhã', 'agenda de amanha',
  ],
  financeiro: [
    'pagamento', 'pagamentos', 'parcela', 'parcelas',
    'faturamento', 'faturou', 'faturaram',
    'financeiro', 'financeira', 'financeiras',
    'recebido', 'recebeu', 'recebidos',
    'valor total', 'quanto entrou', 'quanto recebeu',
    'cobrança', 'cobranca', 'cobranças',
    'vencido', 'vencidos', 'vencida', 'vencidas',
    'resumo financeiro',
    // Contas a pagar ('conta' genérico removido - ambíguo com "me conta", mas 'contas' plural é financeiro)
    'contas a pagar', 'conta a pagar', 'contas pagar', 'contas',
    'despesa', 'despesas', 'gasto', 'gastos',
    'pagar', 'baixa', 'dar baixa',
    'fornecedor', 'boleto',
    'imposto', 'impostos',
    'laboratorio', 'laboratório',
    'antecipação', 'antecipacao', 'lucro', 'lucros', 'retirada',
    'quanto gastei', 'quanto paguei',
    // Importação bancária
    'extrato', 'banco', 'transação', 'transacao', 'transações', 'transacoes',
    'c6', 'c6 bank', 'sincronizar banco', 'sincroniza banco',
    'importar banco', 'saídas do banco', 'saidas do banco',
    // Conta corrente (removido 'entrada' genérico - V12: ambíguo com "entrada do paciente")
    'entradas do banco', 'entradas bancárias', 'venda', 'vendas',
    'conta corrente', 'lancamento', 'lançamento',
    'recebimento', 'recebimentos',
    'importar entradas', 'importar vendas',
    'sincronizar vendas', 'clinicorp',
    'sincronizacao', 'sincronização',
    // Análise e consultoria financeira
    'analise financeira', 'análise financeira', 'analise', 'análise',
    'como estamos', 'saude financeira', 'saúde financeira',
    'conselho', 'opiniao', 'opinião', 'sugestao', 'sugestão',
    'margem', 'lucro liquido', 'lucro líquido', 'rentabilidade',
    'fluxo de caixa', 'previsao', 'previsão',
    // Orçamentos
    'orçamento', 'orcamento', 'orçamentos', 'orcamentos',
    'budget', 'estimate', 'conversão de orçamento', 'conversao de orcamento',
    'ticket médio', 'ticket medio',
  ],
  ponto: [
    'ponto', 'registro de ponto', 'registros de ponto',
    'bateu ponto', 'bater ponto', 'bati ponto',
    'chegou', 'que horas chegou', 'hora que chegou',
    'saiu', 'que horas saiu', 'hora que saiu',
    'horas trabalhada', 'horas trabalhadas', 'total trabalhado',
    'saldo de horas', 'saldo do ponto', 'saldo total', 'saldo acumulado',
    'ausência', 'ausencia', 'ausências', 'ausencias',
    'feriado', 'férias', 'ferias',
    'atestado', 'falta',
    'relatório de ponto', 'relatorio de ponto', 'pdf do ponto', 'pdf de ponto',
    'snapshot', 'saldo snapshot',
  ],
  lembretes: [
    'lembrete', 'lembretes',
    'lembra', 'lembrar', 'me lembre', 'me lembra',
    'não esquece', 'nao esquece', 'não esqueça', 'nao esqueca',
    'pode parar de lembrar', 'para de lembrar',
    'feito', 'já fiz', 'ja fiz', 'já fez', 'ja fez',
    'cancelar lembrete', 'remover lembrete',
    'meus lembretes', 'quais lembretes',
  ],
  paciente: [
    'foto do paciente', 'foto de paciente', 'foto da paciente',
    'adicionar foto', 'adiciona foto',
    'ficha do clinicorp', 'ficha do paciente',
    'termo', 'termos', 'termo de consentimento', 'consentimento',
    'assinatura', 'escaneado', 'escaneada',
  ],
};

/** Cache de último agente por telefone (para continuidade de contexto) */
const lastAgentMap = new Map<string, { agentId: AgentId; timestamp: number }>();

/** TTL de continuidade: 10 minutos */
const CONTINUITY_TTL_MS = 10 * 60 * 1000;

/** Retorna o último agente usado por esse telefone (se dentro do TTL) */
export function getRecentAgentId(phone: string): AgentId | undefined {
  const entry = lastAgentMap.get(phone);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CONTINUITY_TTL_MS) {
    lastAgentMap.delete(phone);
    return undefined;
  }
  return entry.agentId;
}

/** Salva o agente usado nesta interação */
export function setRecentAgentId(phone: string, agentId: AgentId): void {
  lastAgentMap.set(phone, { agentId, timestamp: Date.now() });
}

/**
 * Classifica a intenção da mensagem e retorna qual agente deve tratar.
 * Nível 1: keyword matching (sem custo, <1ms)
 * Nível 2: continuidade de contexto (se nenhuma keyword bateu)
 */
export function classifyIntent(
  message: string,
  mediaType?: string,
  phone?: string,
): RouterResult {
  // Normalizar: lowercase, remover acentos
  const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ── Prioridade forte: sinais inequívocos de lembrete ──
  // "me lembre", "me lembra", "lembrar", "não esquece" sempre vão para lembretes,
  // independente de outras keywords (ex: "me lembre de ver os pacientes")
  const reminderSignals = ['me lembre', 'me lembra', 'lembrar', 'nao esquece', 'nao esqueca'];
  if (reminderSignals.some((s) => lower.includes(s))) {
    return { agentId: 'lembretes', confidence: 0.9 };
  }

  // Pontuar cada agente
  let bestAgent: AgentId = 'geral';
  let bestScore = 0;

  for (const [agentId, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      const kwNorm = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // Frases (multi-palavra) são sinais mais fortes → peso 2
      const weight = kw.includes(' ') ? 2 : 1;
      if (lower.includes(kwNorm)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agentId as AgentId;
    }
  }

  // Mídia: roteamento inteligente
  if (mediaType === 'image' || mediaType === 'document') {
    // Se tem caption/texto com keyword → usa o agente da keyword
    if (bestScore > 0) {
      return { agentId: bestAgent, confidence: Math.min(bestScore / 3, 1) };
    }

    // Sem caption com keyword → continuidade de contexto (último agente)
    if (phone) {
      const recentAgent = getRecentAgentId(phone);
      if (recentAgent && recentAgent !== 'geral') {
        return { agentId: recentAgent, confidence: 0.6 };
      }
    }

    // Sem contexto → default por tipo
    if (mediaType === 'image') return { agentId: 'paciente', confidence: 0.5 };
    return { agentId: 'geral', confidence: 0.4 };
  }

  // Mensagem de texto: se achou keyword, retorna o agente
  if (bestScore > 0) {
    return { agentId: bestAgent, confidence: Math.min(bestScore / 3, 1) };
  }

  // Nenhuma keyword: usar continuidade de contexto
  if (phone) {
    const recentAgent = getRecentAgentId(phone);
    if (recentAgent && recentAgent !== 'geral') {
      return { agentId: recentAgent, confidence: 0.5 };
    }
  }

  // Fallback: agente geral
  return { agentId: 'geral', confidence: 0 };
}
