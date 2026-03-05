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

/** Envia status "digitando..." para o contato */
export async function sendPresenceComposing(phoneOrJid: string): Promise<void> {
  try {
    await client.post(`/chat/sendPresence/${env.EVOLUTION_INSTANCE}`, {
      number: phoneOrJid,
      presence: 'composing',
      delay: 1200,
    });
  } catch (error: any) {
    console.warn('[Evolution] Erro ao enviar presença:', error?.response?.data || error.message);
  }
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
