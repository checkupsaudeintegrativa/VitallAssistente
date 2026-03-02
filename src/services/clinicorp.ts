import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';

const client: AxiosInstance = axios.create({
  baseURL: env.CLINICORP_API_URL,
  timeout: 30000,
});

// Interceptor: injeta Authorization Basic e subscriber_id em toda requisição
client.interceptors.request.use((config) => {
  // Clinicorp usa Basic Auth (base64 de "usuario_api:token_api")
  const apiKey = env.CLINICORP_API_KEY;
  const isBase64 = /^[A-Za-z0-9+/=]+$/.test(apiKey) && apiKey.length > 20;
  const authValue = isBase64
    ? `Basic ${apiKey}`
    : `Basic ${Buffer.from(apiKey).toString('base64')}`;

  config.headers.Authorization = authValue;

  // Injeta subscriber_id como query param
  config.params = {
    subscriber_id: env.CLINICORP_SUBSCRIBER_ID,
    ...config.params,
  };

  return config;
});

/** Lista aniversariantes do dia (ou de uma data específica) */
export async function getBirthdays(date?: string) {
  const params: Record<string, string> = {};
  if (date) params.date = date;

  try {
    const { data } = await client.get('/patient/birthdays', { params });
    return data;
  } catch (error: any) {
    if (error?.response?.status === 400) {
      return [];
    }
    throw error;
  }
}

/** Lista agendamentos num intervalo de datas */
export async function listAppointments(from: string, to: string) {
  const { data } = await client.get('/appointment/list', {
    params: {
      from,
      to,
      businessId: env.CLINICORP_BUSINESS_ID,
    },
  });
  return data;
}

/** Lista pagamentos/parcelas individuais num intervalo de datas */
export async function listPayments(from: string, to: string, dateType?: string) {
  const params: Record<string, string> = {
    from,
    to,
    business_id: env.CLINICORP_BUSINESS_ID,
  };
  if (dateType) params.date_type = dateType;

  const { data } = await client.get('/payment/list', { params });
  return data;
}

/** Lista resumo financeiro num intervalo de datas */
export async function listFinancialSummary(from: string, to: string) {
  const { data } = await client.get('/financial/list_summary', {
    params: {
      from,
      to,
      business_id: env.CLINICORP_BUSINESS_ID,
    },
  });
  return data;
}

/** Lista usuários do sistema (para mapear dentistas) */
export async function listUsers() {
  const { data } = await client.get('/security/list_users');
  return data?.list || data;
}
