import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { formatPhoneBR } from '../utils/phone';

const client: AxiosInstance = axios.create({
  baseURL: env.EVOLUTION_API_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    apikey: env.EVOLUTION_API_KEY,
  },
});

/** Delay entre mensagens para evitar bloqueio do WhatsApp */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Envia presença (composing ou recording) para o contato */
async function sendPresence(phoneOrJid: string, type: 'composing' | 'recording'): Promise<void> {
  try {
    await client.post(`/chat/sendPresence/${env.EVOLUTION_INSTANCE}`, {
      number: phoneOrJid,
      presence: type,
      delay: 1200,
    });
  } catch (error: any) {
    console.warn(`[Evolution] Erro ao enviar presença ${type}:`, error?.response?.data || error.message);
  }
}

/** Controladores de presença ativos, indexados por phone (para lookup do executeSendAudio) */
const activePresence = new Map<string, { setMode: (m: 'composing' | 'recording') => void }>();

/** Busca controlador de presença ativo para um telefone (usado por ai-tools para trocar composing↔recording) */
export function getPresenceController(phone: string) {
  return activePresence.get(phone);
}

/**
 * Inicia loop de presença que reenvia a cada intervalMs até chamar stop().
 * Suporta troca de modo (composing ↔ recording) em tempo real sem criar novo loop.
 * @param phoneOrJid  Identificador para a API (remoteJid ou phone)
 * @param phoneKey    Chave adicional para lookup (senderPhone) — permite ai-tools encontrar o controlador
 */
export function startPresenceLoop(phoneOrJid: string, intervalMs = 4000, phoneKey?: string): () => void {
  let active = true;
  let mode: 'composing' | 'recording' = 'composing';

  const send = () => sendPresence(phoneOrJid, mode).catch(() => {});

  // Envia imediatamente
  send();

  // Reenvia a cada intervalo
  const timer = setInterval(() => {
    if (!active) return;
    send();
  }, intervalMs);

  const controller = {
    setMode: (m: 'composing' | 'recording') => {
      mode = m;
      send(); // troca instantânea
    },
  };

  // Registra por phoneKey para o executeSendAudio poder trocar o modo
  if (phoneKey) activePresence.set(phoneKey, controller);

  return () => {
    active = false;
    clearInterval(timer);
    if (phoneKey) activePresence.delete(phoneKey);
  };
}

/** Resolve o identificador de destino: usa remoteJid para LIDs, senão formata o telefone */
function resolveNumber(phone: string, remoteJid?: string): string | null {
  // Se temos um remoteJid @lid, usar ele diretamente (WhatsApp pessoal)
  if (remoteJid && remoteJid.endsWith('@lid')) {
    return remoteJid;
  }
  return formatPhoneBR(phone);
}

/** Envia mensagem de texto via Evolution API */
export async function sendText(phone: string, text: string, remoteJid?: string): Promise<boolean> {
  const number = resolveNumber(phone, remoteJid);
  if (!number) {
    console.error('[Evolution] Telefone inválido:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendText/${env.EVOLUTION_INSTANCE}`, {
      number,
      text,
    });

    await delay(1500);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar mensagem para',
      number,
      ':',
      error?.response?.data || error.message
    );
    return false;
  }
}

/** Envia mensagem de texto como REPLY (citando a mensagem original) */
export async function sendTextReply(
  phone: string,
  text: string,
  quotedMessageId: string,
  remoteJid: string
): Promise<boolean> {
  const number = resolveNumber(phone, remoteJid);
  if (!number) {
    console.error('[Evolution] Telefone inválido:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendText/${env.EVOLUTION_INSTANCE}`, {
      number,
      text,
      quoted: {
        key: {
          remoteJid,
          fromMe: false,
          id: quotedMessageId,
        },
      },
    });

    await delay(1500);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar reply para',
      number,
      ':',
      error?.response?.data || error.message
    );
    // Fallback: envia como mensagem normal se o reply falhar
    return sendText(phone, text, remoteJid);
  }
}

/** Envia documento/mídia via Evolution API (ex: PDF) */
export async function sendMedia(
  phone: string,
  base64: string,
  fileName: string,
  caption?: string,
  mimetype: string = 'application/pdf'
): Promise<boolean> {
  const number = formatPhoneBR(phone);
  if (!number) {
    console.error('[Evolution] Telefone inválido para sendMedia:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendMedia/${env.EVOLUTION_INSTANCE}`, {
      number,
      mediatype: 'document',
      media: base64,
      fileName,
      caption: caption || '',
    });

    await delay(2000);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar mídia para',
      number,
      ':',
      error?.response?.data || error.message
    );
    return false;
  }
}

/** Envia imagem inline via Evolution API (aparece como foto, não documento) */
export async function sendImage(
  phone: string,
  base64: string,
  caption?: string,
  remoteJid?: string
): Promise<boolean> {
  const number = resolveNumber(phone, remoteJid);
  if (!number) {
    console.error('[Evolution] Telefone inválido para sendImage:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendMedia/${env.EVOLUTION_INSTANCE}`, {
      number,
      mediatype: 'image',
      mimetype: 'image/png',
      media: base64,
      caption: caption || '',
    });

    await delay(2000);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar imagem para',
      number,
      ':',
      error?.response?.data || error.message
    );
    return false;
  }
}

/** Envia áudio como mensagem de voz (PTT) via Evolution API */
export async function sendAudio(
  phone: string,
  base64: string,
  remoteJid?: string
): Promise<boolean> {
  const number = resolveNumber(phone, remoteJid);
  if (!number) {
    console.error('[Evolution] Telefone inválido para sendAudio:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendWhatsAppAudio/${env.EVOLUTION_INSTANCE}`, {
      number,
      audio: base64,
      encoding: true,
    });

    await delay(2000);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar áudio para',
      number,
      ':',
      error?.response?.data || error.message
    );
    return false;
  }
}

/** Baixa mídia (imagem/PDF/áudio) de uma mensagem como base64 */
export async function getBase64FromMedia(
  messageId: string,
  remoteJid: string
): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const { data } = await client.post(
      `/chat/getBase64FromMediaMessage/${env.EVOLUTION_INSTANCE}`,
      {
        message: {
          key: {
            id: messageId,
            remoteJid,
          },
        },
      }
    );

    if (data?.base64) {
      return {
        base64: data.base64,
        mimetype: data.mimetype || 'image/jpeg',
      };
    }
    return null;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao baixar mídia',
      messageId,
      ':',
      error?.response?.data || error.message
    );
    return null;
  }
}
