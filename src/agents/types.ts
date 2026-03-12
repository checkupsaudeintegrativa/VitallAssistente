import { UserConfig } from '../config/users';

/** Identificador único de cada agente */
export type AgentId = 'agenda' | 'financeiro' | 'ponto' | 'lembretes' | 'paciente' | 'geral';

/** Controle de acesso: quem pode usar este agente */
export interface AgentAccess {
  /** Roles que podem acessar. Undefined = todos podem */
  allowedRoles?: ('admin' | 'staff')[];
  /** Mensagem ao negar acesso */
  deniedMessage?: string;
}

/** Configuração de um agente de domínio */
export interface AgentConfig {
  id: AgentId;
  /** Nome legível (para logs) */
  name: string;
  /** Modelo OpenAI a usar (default: 'gpt-4o') */
  model?: string;
  /** Nomes das tools que este agente usa (referências a toolDefinitions em ai-tools.ts) */
  toolNames: string[];
  /** Regras de acesso */
  access: AgentAccess;
  /** Constrói o prompt específico do domínio */
  buildPrompt: (userName: string, role?: string, features?: UserConfig['features']) => string;
  /** Tools que exigem admin mesmo dentro deste agente */
  adminOnlyTools?: Set<string>;
}

/** Resultado da classificação de intent */
export interface RouterResult {
  agentId: AgentId;
  confidence: number;
}
