/**
 * Formata número de telefone BR para o padrão WhatsApp: 55DDDNUMERO
 * Remove caracteres especiais e garante formato correto.
 */
export function formatPhoneBR(phone: string | null | undefined): string | null {
  if (!phone) return null;

  // Remove tudo que não for dígito
  const digits = phone.replace(/\D/g, '');

  if (digits.length === 0) return null;

  // Já tem código do país (55)
  if (digits.startsWith('55') && digits.length >= 12) {
    return digits;
  }

  // Tem DDD + número (11 dígitos com 9 na frente, ou 10 sem)
  if (digits.length === 11) {
    return `55${digits}`;
  }

  // Número antigo sem o 9 (10 dígitos): adiciona 9 após DDD
  if (digits.length === 10) {
    const ddd = digits.substring(0, 2);
    const number = digits.substring(2);
    return `55${ddd}9${number}`;
  }

  // Se não se enquadra, retorna com 55 na frente mesmo assim
  return `55${digits}`;
}
