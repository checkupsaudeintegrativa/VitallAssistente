import { format, addDays, subDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const TIMEZONE = 'America/Sao_Paulo';

/** Retorna a data atual em BRT */
export function nowBRT(): Date {
  return toZonedTime(new Date(), TIMEZONE);
}

/** Formata data como YYYY-MM-DD */
export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Retorna data de hoje formatada (BRT) */
export function today(): string {
  return formatDate(nowBRT());
}

/** Retorna data de D+N dias formatada (BRT) */
export function daysFromNow(n: number): string {
  return formatDate(addDays(nowBRT(), n));
}

/** Retorna data de D-N dias formatada (BRT) */
export function daysAgo(n: number): string {
  return formatDate(subDays(nowBRT(), n));
}

/** Formata data DD/MM/YYYY para exibição em mensagens */
export function formatDateBR(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Formata data como "DD/MM, dia-da-semana" (ex: "06/02, sexta-feira") */
export function formatDateBRWithWeekday(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return `${day}/${month}, ${WEEKDAYS[date.getDay()]}`;
}

/** Retorna só o dia da semana (ex: "sexta-feira") */
export function formatDateBRWeekdayOnly(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return WEEKDAYS[date.getDay()];
}
