import { AgentConfig, AgentId } from './types';
import { agendaAgent } from './agents/agenda';
import { financeiroAgent } from './agents/financeiro';
import { pontoAgent } from './agents/ponto';
import { lembretesAgent } from './agents/lembretes';
import { pacienteAgent } from './agents/paciente';
import { geralAgent } from './agents/geral';

const AGENTS = new Map<AgentId, AgentConfig>();

for (const agent of [agendaAgent, financeiroAgent, pontoAgent, lembretesAgent, pacienteAgent, geralAgent]) {
  AGENTS.set(agent.id, agent);
}

/** Retorna config de um agente pelo ID */
export function getAgent(id: AgentId): AgentConfig {
  const agent = AGENTS.get(id);
  if (!agent) throw new Error(`Agente desconhecido: ${id}`);
  return agent;
}

/** Retorna todos os agentes registrados */
export function getAllAgents(): AgentConfig[] {
  return Array.from(AGENTS.values());
}
