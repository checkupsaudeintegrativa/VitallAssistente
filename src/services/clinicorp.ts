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

/** Lista orçamentos (estimates) num intervalo de datas */
export async function listBudgets(from: string, to: string, groupBy?: string) {
  const params: Record<string, string> = {
    from,
    to,
    business_id: env.CLINICORP_BUSINESS_ID,
  };
  if (groupBy) params.group_by = groupBy;

  const { data } = await client.get('/sales/estimates_and_conversion', { params });
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

/** Busca paciente pelo nome — retorna PatientId e dados */
export async function searchPatient(name: string): Promise<{ PatientId: number; Name: string } | null> {
  try {
    const { data } = await client.get('/patient/get', {
      params: { Name: name },
    });

    // API pode retornar objeto ou array
    if (Array.isArray(data) && data.length > 0) {
      return { PatientId: data[0].PatientId, Name: data[0].Name };
    }
    if (data?.PatientId) {
      return { PatientId: data.PatientId, Name: data.Name };
    }
    return null;
  } catch (error: any) {
    console.error('[Clinicorp] Erro ao buscar paciente:', error.message);
    return null;
  }
}

/** Upload de arquivo para a ficha do paciente (foto de perfil, documento, etc.) */
export async function uploadFile(
  patientId: number,
  patientName: string,
  imageUrl: string,
  localFile: 'Person.Profile' | 'Person.Photo' | 'Person.Document' | 'Person.File' = 'Person.Profile'
): Promise<{ success: boolean; status?: string; error?: string }> {
  try {
    const { data } = await client.post('/file/upload', [
      {
        Url: imageUrl,
        LocalFile: localFile,
        PatientName: patientName,
        PatinetId: patientId, // Typo é da API do Clinicorp mesmo
      },
    ]);

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.Status === 'SUCCESS') {
      return { success: true, status: 'SUCCESS' };
    }
    return { success: false, status: result?.Status || 'UNKNOWN', error: result?.Message };
  } catch (error: any) {
    console.error('[Clinicorp] Erro no upload:', error?.response?.data || error.message);
    return { success: false, error: error.message };
  }
}
