import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  // Clinicorp (usado pelas ferramentas da IA para consultar agenda, pagamentos, etc.)
  CLINICORP_API_URL: required('CLINICORP_API_URL'),
  CLINICORP_API_KEY: required('CLINICORP_API_KEY'),
  CLINICORP_SUBSCRIBER_ID: required('CLINICORP_SUBSCRIBER_ID'),
  CLINICORP_BUSINESS_ID: required('CLINICORP_BUSINESS_ID'),

  // Evolution API (instância do WhatsApp Assistente)
  EVOLUTION_API_URL: required('EVOLUTION_API_URL'),
  EVOLUTION_API_KEY: required('EVOLUTION_API_KEY'),
  EVOLUTION_INSTANCE: required('EVOLUTION_INSTANCE'),

  // Supabase (mesmo banco — tabelas chat_messages, jessica_reminders, dentist_phones)
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),

  // OpenAI (GPT-4o + Whisper)
  OPENAI_API_KEY: required('OPENAI_API_KEY'),

  // Google Calendar (OAuth — mesmo CLIENT_ID/SECRET para todas as contas)
  GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
  GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '',
  GOOGLE_CALENDAR_REFRESH_TOKEN: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || '',

  // Google Calendar — conta da clínica (Jéssica + Dra. Ana)
  GOOGLE_CALENDAR_CLINIC_REFRESH_TOKEN: process.env.GOOGLE_CALENDAR_CLINIC_REFRESH_TOKEN || '',
  GOOGLE_CALENDAR_JESSICA_ID: process.env.GOOGLE_CALENDAR_JESSICA_ID || '',
  GOOGLE_CALENDAR_ANA_ID: process.env.GOOGLE_CALENDAR_ANA_ID || '',

  // App
  PORT: process.env.PORT || '3000',

  // Telefone da Jéssica (para enviar lembretes)
  JESSICA_PHONE: process.env.JESSICA_PHONE || '5511943550921',

  // Test mode
  TEST_MODE: process.env.TEST_MODE === 'true',
  TEST_PHONE: process.env.TEST_PHONE || '',
};
