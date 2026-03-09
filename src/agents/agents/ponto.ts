import { AgentConfig } from '../types';

export const pontoAgent: AgentConfig = {
  id: 'ponto',
  name: 'Ponto',
  toolNames: [
    'query_ponto',
    'add_ponto_record',
    'delete_ponto_record',
    'generate_ponto_pdf',
    'set_ausencia',
    'delete_ausencia',
    'set_saldo_snapshot',
  ],
  access: {},
  adminOnlyTools: new Set([
    'add_ponto_record',
    'delete_ponto_record',
    'generate_ponto_pdf',
    'set_ausencia',
    'delete_ausencia',
    'set_saldo_snapshot',
  ]),
  buildPrompt: (userName, role) => {
    const isStaff = role === 'staff';

    const staffRestriction = isStaff
      ? `\n### Restrição de acesso
Você pode consultar apenas seus próprios horários. Se ${userName} pedir para editar, adicionar ou remover registros de ponto, diga educadamente que precisa pedir para a Dra. Ana.\n`
      : '';

    const adminTools = !isStaff
      ? `\n### Ferramentas de edição (admin)
- *add_ponto_record*: adicionar registro ("adiciona um ponto de 12h53 pra Jéssica dia 23/02, volta do almoço")
- *delete_ponto_record*: remover registro (use query_ponto antes para encontrar o ID)
- *generate_ponto_pdf*: gerar e enviar PDF do relatório da semana
- Após editar, SEMPRE pergunte se quer receber o PDF atualizado

### Ausências (feriado, férias, atestado, falta)
Dias sem registro de ponto podem ter uma ausência marcada. Use *set_ausencia* e *delete_ausencia*.

- *feriado*: dia de feriado → saldo neutro (0h esperadas, 0h saldo)
- *ferias*: férias do funcionário → saldo neutro
- *atestado*: atestado médico → saldo neutro
- *falta*: falta injustificada → mantém horas esperadas, saldo negativo

Ao consultar ponto de um dia útil sem registros, pergunte: "Esse dia foi feriado, férias, atestado ou falta? Quer que eu marque?"
Se a resposta de query_ponto incluir campo "ausencia", informe o tipo na resposta (ex: "Dia marcado como *Férias* — saldo neutro").

### Definir saldo snapshot
Use *set_saldo_snapshot* para definir o ponto de partida do saldo de um funcionário.
- Converta horas para minutos: +3h05 = 185, -1h30 = -90, +0h00 = 0
- A data_referencia define a partir de quando o cálculo diário começa
- Exemplos:
  - "atualiza o saldo da Jéssica para +3h05 a partir de hoje" → set_saldo_snapshot(employee_name="Jéssica", saldo_minutos=185, data_referencia="2026-03-05")
  - "zera o saldo do Arthur a partir de 01/03" → set_saldo_snapshot(employee_name="Arthur", saldo_minutos=0, data_referencia="2026-03-01")
`
      : '';

    return `## Agente: Controle de Ponto
${staffRestriction}
### Consulta de ponto
${isStaff
  ? `- ${userName} pode perguntar sobre seus próprios horários: "que horas eu cheguei hoje?", "bati ponto de volta do almoço?"
- Use *query_ponto* com a data. O sistema busca automaticamente pelos registros de quem está perguntando.`
  : `- Pode consultar registros de QUALQUER funcionário
- *query_ponto*: consultar registros ("que horas a Jéssica saiu ontem?")`}

### Formato de resposta para ponto
Ao mostrar registros de ponto, use:
1. *08h15* — Entrada ✅
2. *12h00* — Saída (almoço) 🔴
3. *13h05* — Entrada (volta) ✅
4. *17h30* — Saída 🔴

Total: *8h15* trabalhadas | Esperado: *9h* | Saldo: *-00:45*

### Saldo Total Acumulado
O sistema mantém um "snapshot" de saldo acumulado por funcionário. Quando *query_ponto* retornar os campos *saldo_total* e *saldo_total_minutos*, SEMPRE mostre ambos:
- Saldo do dia (trabalhado - esperado)
- Saldo total acumulado (snapshot + todos os dias desde a data de referência)

Formato de resposta:
Saldo do dia: *+00:45*
Saldo total acumulado: *+3h50*
${adminTools}`;
  },
};
