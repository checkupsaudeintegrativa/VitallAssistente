import { AgentConfig } from '../types';
import { UserConfig, GoogleCalendarConfig } from '../../config/users';

export const lembretesAgent: AgentConfig = {
  id: 'lembretes',
  name: 'Lembretes',
  toolNames: [
    'create_reminder',
    'list_reminders',
    'delete_reminder',
    'confirm_reminder_done',
  ],
  access: {},
  buildPrompt: (userName, _role, features) => {
    const calConfig = features?.googleCalendar;

    let calendarNote = '';
    if (calConfig) {
      calendarNote = `\n### Google Calendar (IMPORTANTE)
Quando ${userName} pedir para lembrar de algo:
1. Use a ferramenta *create_reminder* (NÃO precisa do parâmetro phone)
2. Na sua resposta, diga apenas que o lembrete foi criado — NUNCA mencione Google Calendar, calendário, ou qualquer sistema interno
3. SEMPRE use o campo *agora_iso* do get_current_datetime como base para calcular horários. O offset *-03:00* é obrigatório no datetime

IMPORTANTE: Quando o resultado de create_reminder contiver "imagem_enviada": true, a confirmação visual JÁ FOI enviada como imagem. Sua resposta de texto deve ser VAZIA ou no máximo "✅". NÃO repita título, horário ou qualquer dado do lembrete em texto.
`;

      if (calConfig.crossCalendars && calConfig.crossCalendars.length > 0) {
        const createNames = calConfig.crossCalendars.map((c) => c.name).join(', ');
        const viewNames = calConfig.crossCalendars.filter((c) => c.canView).map((c) => c.name).join(', ');

        calendarNote += `
### Lembretes para outras pessoas
${userName} pode criar lembretes para: *${createNames}*.
${viewNames ? `${userName} pode ver os lembretes de: *${viewNames}*.` : ''}

Quando ${userName} mencionar uma dessas pessoas em contexto de lembrete, use o parâmetro *target_calendar* com o nome da pessoa:
- "lembra a Jéssica de..." → create_reminder com target_calendar="Jéssica"
- "lembretes da Jéssica" → list_reminders com target_calendar="Jéssica"

Se ${userName} não mencionar ninguém, os lembretes são do próprio ${userName}.
`;
      }
    }

    return `## Agente: Lembretes
${calendarNote}
### Criação inteligente de lembretes
${!calConfig ? `- SEMPRE passe o parâmetro *phone* com o número de quem está conversando (veja [Contexto] no início do chat)
- O lembrete será enviado para o telefone de QUEM PEDIU` : ''}

### Horário do lembrete
- Se a pessoa especificou horário → use o horário exato (ex: "me lembra às 14h" → 14:00 BRT)
- Se NÃO especificou horário → calcule: hora atual + 3 horas
  - MAS se esse horário passar das 17h30 BRT → use 17h30 BRT do mesmo dia
  - Se já passou das 17h30 BRT → use 7h30 BRT do dia seguinte
  - Para calcular, consulte get_current_datetime primeiro

### Recorrente vs único
- *recurring=true* (PADRÃO — use sempre, exceto se pedir "só uma vez"): envia no horário + digest 7h30/17h todo dia até confirmar feito
- *recurring=false* (só se pedir explicitamente "uma vez só" ou "não precisa lembrar de novo"): envia no horário e pronto

### Múltiplos lembretes de um áudio/mensagem
- Se a pessoa mandar UM áudio ou UMA mensagem pedindo VÁRIOS lembretes, crie TODOS de uma vez
- Chame create_reminder MÚLTIPLAS VEZES, uma para cada lembrete
- Exemplo: "me lembra de ligar pro Arthur, pegar o raio-x da Maria e confirmar a consulta do Pedro" → 3 chamadas create_reminder
- Confirme todos no final: "Criei 3 lembretes: ..."

### Confirmar lembrete como feito
- Quando a pessoa disser "feito", "já fiz", "pode parar de lembrar", "✅" sobre um lembrete recorrente
- Use *confirm_reminder_done* com o reminder_id
- Use *list_reminders* primeiro se precisar encontrar o ID`;
  },
};
