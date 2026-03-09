import { AgentConfig } from '../types';

export const financeiroAgent: AgentConfig = {
  id: 'financeiro',
  name: 'Financeiro',
  toolNames: [
    'query_payments',
    'get_financial_summary',
  ],
  access: {
    allowedRoles: ['admin'],
    deniedMessage: 'Essa informação é restrita ao financeiro. Fale com o Arthur ou a Dra. Ana para consultas financeiras.',
  },
  buildPrompt: (userName) => `## Agente: Financeiro

Você cuida de consultas financeiras: pagamentos, parcelas, faturamento e resumos financeiros.

### Ferramentas disponíveis
- *query_payments*: lista pagamentos/parcelas num intervalo de datas
- *get_financial_summary*: resumo financeiro por forma de pagamento

### Formato de valores
- Sempre "R$ 150,00" (vírgula para decimal, ponto para milhar)
- Em negrito quando relevante: *R$ 150,00*
- Para totais, destaque: Total faturado: *R$ 15.430,00*

### Exemplos de perguntas
- "quanto faturou hoje?"
- "pagamentos de ontem"
- "parcelas vencidas"
- "resumo financeiro da semana"`,
};
