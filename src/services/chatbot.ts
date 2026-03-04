import * as evolution from './evolution';
import * as db from './supabase';
import { chatWithTools, transcribeAudio, ChatMessage } from './openai';
import { buildSystemPrompt } from '../templates/system-prompt';
import { getUserByPhone } from '../config/users';

/** Tipos de mídia detectáveis no payload da Evolution API */
type MediaType = 'text' | 'image' | 'audio' | 'document';

export interface IncomingMessage {
  remoteJid: string;
  messageId: string;
  senderPhone: string;
  senderName: string;
  text: string;
  mediaType: MediaType;
  message: any; // raw Evolution API message payload
}

/** Formata timestamp BRT para exibição no contexto */
function formatTimestampBRT(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Retorna label de data relativa: "hoje", "ontem", ou a data */
function getDateLabel(isoDate: string): string {
  const d = new Date(isoDate);
  const msgDate = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const now = new Date();
  const todayStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (msgDate === todayStr) return 'hoje';
  if (msgDate === yesterdayStr) return 'ontem';
  return msgDate;
}

/**
 * Monta o histórico formatado com timestamps e separadores de dia.
 * Cada mensagem inclui [hora] para a IA saber quando foi enviada.
 * Dias diferentes são separados com um marcador de contexto.
 */
function buildContextMessages(
  history: { role: string; content: string; created_at: string }[]
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lastDateLabel = '';

  for (const h of history) {
    const dateLabel = getDateLabel(h.created_at);

    // Inserir separador quando muda o dia
    if (dateLabel !== lastDateLabel) {
      const time = new Date(h.created_at).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      messages.push({
        role: 'system',
        content: `--- Conversa de ${dateLabel} (${new Date(h.created_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, a partir das ${time}) ---`,
      });
      lastDateLabel = dateLabel;
    }

    // Conteúdo limpo, sem prefixo de horário (para a IA não copiar o padrão)
    messages.push({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    });
  }

  return messages;
}

/**
 * Handler principal do chatbot IA.
 * Processa mensagem recebida, detecta tipo, e responde via GPT-4o.
 */
export async function handleChatbotMessage(msg: IncomingMessage): Promise<void> {
  const { senderPhone, senderName, remoteJid, messageId, text, mediaType, message } = msg;

  console.log(`[Chatbot] Mensagem de ${senderPhone} (tipo: ${mediaType}): "${text.substring(0, 100)}"`);

  try {
    let userContent = text;
    let imageBase64: string | undefined;
    let imageMime: string | undefined;
    let imageStorageUrl: string | undefined;

    // ── Processar mídia ──
    if (mediaType === 'image') {
      const media = await evolution.getBase64FromMedia(messageId, remoteJid);
      if (media) {
        imageBase64 = media.base64;
        imageMime = media.mimetype;
        userContent = text || 'Imagem enviada.';

        // Upload para Supabase Storage para ter URL pública (usada pelo Clinicorp)
        const url = await db.uploadImageToStorage(media.base64, media.mimetype);
        if (url) {
          imageStorageUrl = url;
          console.log(`[Chatbot] Imagem salva no Storage: ${url.substring(0, 80)}...`);
        }
      } else {
        userContent = '[Imagem não pôde ser processada]';
      }
    } else if (mediaType === 'audio') {
      const media = await evolution.getBase64FromMedia(messageId, remoteJid);
      if (media) {
        const transcription = await transcribeAudio(media.base64, media.mimetype);
        if (transcription) {
          userContent = transcription;
          console.log(`[Chatbot] Áudio transcrito: "${transcription.substring(0, 100)}"`);
        } else {
          userContent = '[Áudio não pôde ser transcrito]';
        }
      } else {
        userContent = '[Áudio não pôde ser processado]';
      }
    } else if (mediaType === 'document') {
      const media = await evolution.getBase64FromMedia(messageId, remoteJid);
      if (media) {
        if (media.mimetype.includes('pdf') || media.mimetype.includes('image')) {
          imageBase64 = media.base64;
          imageMime = media.mimetype.includes('pdf') ? 'image/png' : media.mimetype;
          userContent = text || `${senderName} enviou um documento/PDF.`;
        } else {
          userContent = text || '[Documento enviado]';
        }
      } else {
        userContent = '[Documento não pôde ser processado]';
      }
    }

    // Salvar mensagem da Jéssica no histórico
    await db.saveChatMessage(senderPhone, 'user', userContent, mediaType);

    // Buscar histórico de conversa (últimas 30 mensagens com timestamps)
    const history = await db.getChatHistory(senderPhone, 30);

    console.log(`[Chatbot] Histórico carregado: ${history.length} mensagens`);

    // Montar mensagens com contexto temporal (separadores de dia + horários)
    const contextMessages = buildContextMessages(history);

    // Montar contexto dinâmico
    let dynamicContext = `[Contexto] Quem está conversando: *${senderName}* (telefone: ${senderPhone}). Chame sempre pelo nome "${senderName}". Use o telefone no parâmetro "phone" ao criar lembretes.`;
    if (imageStorageUrl) {
      dynamicContext += `\n[Imagem] URL pública da imagem enviada: ${imageStorageUrl} — use esta URL no parâmetro "image_url" de upload_patient_photo se for foto de paciente.`;
    }

    // Resolver permissões do usuário (para prompt e tools)
    const userConfig = getUserByPhone(senderPhone);

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(senderName, userConfig?.role) },
      { role: 'system', content: dynamicContext },
      ...contextMessages,
    ];

    // Se o histórico não inclui a mensagem atual (race condition), adiciona
    const lastHistoryMsg = history[history.length - 1];
    if (!lastHistoryMsg || lastHistoryMsg.content !== userContent || lastHistoryMsg.role !== 'user') {
      messages.push({ role: 'user', content: userContent });
    }

    // Mostrar "digitando..." antes de responder
    try {
      await evolution.sendPresenceComposing(remoteJid);
    } catch {
      // presença é best-effort
    }

    // Chamar GPT-4o com function calling (tools)
    const aiResponse = await chatWithTools(messages, imageBase64, imageMime, userConfig);

    // Salvar resposta da IA no histórico
    await db.saveChatMessage(senderPhone, 'assistant', aiResponse, 'text');

    // Separar em múltiplas mensagens se a IA usou o marcador ---SEPARAR---
    const parts = aiResponse.split(/---SEPARAR---/i).map((p) => p.trim()).filter(Boolean);

    // Primeira mensagem como reply (citando a original), demais como mensagens normais
    for (let i = 0; i < parts.length; i++) {
      const prefixed = `> *Vitall:*\n\n${parts[i]}`;

      if (i === 0) {
        await evolution.sendTextReply(senderPhone, prefixed, messageId, remoteJid);
      } else {
        // Mostrar "digitando..." antes de cada mensagem adicional
        try { await evolution.sendPresenceComposing(remoteJid); } catch {}
        await evolution.sendText(senderPhone, prefixed, remoteJid);
      }
    }

    console.log(`[Chatbot] ${parts.length} msg(s) enviada(s) para ${senderPhone}: "${aiResponse.substring(0, 100)}"`);
  } catch (error: any) {
    console.error(`[Chatbot] Erro ao processar mensagem de ${senderPhone}:`, error.message);

    await evolution.sendText(
      senderPhone,
      '> *Vitall:*\n\nDesculpe, tive um problema ao processar sua mensagem. Tente novamente em instantes.',
      remoteJid
    );
  }
}
