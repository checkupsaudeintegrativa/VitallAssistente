export type UserRole = 'admin' | 'staff';

export interface UserConfig {
  name: string;
  role: UserRole;
  phones: string[];
  features: {
    financial: boolean;
    googleCalendar?: boolean;
  };
}

const USERS: UserConfig[] = [
  {
    name: 'Jéssica',
    role: 'staff',
    phones: ['5511934550921', '5511917293419'],
    features: { financial: false },
  },
  {
    name: 'Arthur',
    role: 'admin',
    phones: ['5511943635555'],
    features: { financial: true, googleCalendar: true },
  },
  {
    name: 'Dra. Ana',
    role: 'admin',
    phones: ['5511944655555'],
    features: { financial: true },
  },
];

/** Mapa de telefone → UserConfig */
export const USER_BY_PHONE = new Map<string, UserConfig>();
for (const user of USERS) {
  for (const phone of user.phones) {
    USER_BY_PHONE.set(phone, user);
  }
}

/** Set de todos os telefones autorizados */
export const ALLOWED_PHONES = new Set<string>(USER_BY_PHONE.keys());

/** Mapa de telefone → nome (compatibilidade com handler) */
export const PHONE_NAMES: Record<string, string> = {};
for (const user of USERS) {
  for (const phone of user.phones) {
    PHONE_NAMES[phone] = user.name;
  }
}

/** Retorna UserConfig pelo telefone, ou null se não autorizado */
export function getUserByPhone(phone: string): UserConfig | null {
  return USER_BY_PHONE.get(phone) || null;
}

/** Resolve telefone de LID (opaco) pelo pushName */
export function resolveLidPhone(pushName: string): string {
  const lower = (pushName || '').toLowerCase();
  for (const user of USERS) {
    const nameNorm = user.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nameParts = nameNorm.split(/\s+/);
    if (nameParts.some((part) => lower.includes(part))) {
      return user.phones[0];
    }
  }
  // Fallback: primeiro telefone da Jéssica
  return USERS[0].phones[0];
}
