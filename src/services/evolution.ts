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
export async function sendPresenceComposing(formattedPhone: string): Promise<void> {
  try {
    await client.post(`/chat/updatePresence/${env.EVOLUTION_INSTANCE}`, {
      number: formattedPhone,
      presence: 'composing',
    });
  } catch (error: any) {
    console.warn('[Evolution] Erro ao enviar presença:', error?.response?.data || error.message);
  }
}

/** Envia mensagem de texto via Evolution API */
export async function sendText(phone: string, text: string): Promise<boolean> {
  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) {
    console.error('[Evolution] Telefone inválido:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendText/${env.EVOLUTION_INSTANCE}`, {
      number: formattedPhone,
      text,
    });

    await delay(1500);
    return true;
  } catch (error: any) {
    console.error(
      '[Evolution] Erro ao enviar mensagem para',
      formattedPhone,
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
  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) {
    console.error('[Evolution] Telefone inválido:', phone);
    return false;
  }

  try {
    await client.post(`/message/sendText/${env.EVOLUTION_INSTANCE}`, {
      number: formattedPhone,
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
      formattedPhone,
      ':',
      error?.response?.data || error.message
    );
    // Fallback: envia como mensagem normal se o reply falhar
    return sendText(phone, text);
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
