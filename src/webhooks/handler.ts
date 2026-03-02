import { Router, Request, Response } from 'express';
import { formatPhoneBR } from '../utils/phone';
import { handleChatbotMessage, IncomingMessage } from '../services/chatbot';

const router = Router();

/** Números autorizados a usar a IA */
const ALLOWED_PHONES = [
  '5511943550921',  // Jéssica (principal)
  '5511943635555',  // Arthur (teste)
  '5511917293419',  // Jéssica (segundo número)
];

/**
 * Webhook da Evolution API — WhatsApp Assistente (IA da Jéssica)
 *
 * Responde APENAS para os números autorizados.
 */
router.post('/webhook/evolution', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    if (!body || !body.data) {
      res.status(200).json({ status: 'ignored', reason: 'no data' });
      return;
    }

    const data = body.data;

    const remoteJid = data.key?.remoteJid || '';
    const messageText =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      data.message?.buttonsResponseMessage?.selectedDisplayText ||
      data.message?.templateButtonReplyMessage?.selectedDisplayText ||
      data.message?.imageMessage?.caption ||
      data.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
      '';

    // Extrai número do remetente (remove @s.whatsapp.net)
    const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    const formattedPhone = formatPhoneBR(senderPhone) || senderPhone;

    // Ignora mensagens enviadas pela própria IA (prefixo *Vitall:*)
    if (messageText.startsWith('*Vitall:*') || messageText.startsWith('> *Vitall:*')) {
      res.status(200).json({ status: 'ignored', reason: 'own response' });
      return;
    }

    // Ignora mensagens enviadas por nós (fromMe = true)
    if (data.key?.fromMe) {
      res.status(200).json({ status: 'ignored', reason: 'fromMe' });
      return;
    }

    // Ignora mensagens de grupo
    if (remoteJid.includes('@g.us')) {
      res.status(200).json({ status: 'ignored', reason: 'group message' });
      return;
    }

    // Só responde para números autorizados
    if (!ALLOWED_PHONES.includes(formattedPhone)) {
      console.log(`[Webhook] Número não autorizado: ${formattedPhone}, ignorando`);
      res.status(200).json({ status: 'ignored', reason: 'unauthorized phone' });
      return;
    }

    // Detecta tipo de mídia
    let mediaType: 'text' | 'image' | 'audio' | 'document' = 'text';
    if (data.message?.imageMessage) {
      mediaType = 'image';
    } else if (data.message?.audioMessage) {
      mediaType = 'audio';
    } else if (data.message?.documentMessage || data.message?.documentWithCaptionMessage) {
      mediaType = 'document';
    }

    // Para mensagens sem texto e sem mídia, ignorar
    if (mediaType === 'text' && !messageText) {
      res.status(200).json({ status: 'ignored', reason: 'no content' });
      return;
    }

    console.log(`[Webhook] Mensagem de ${formattedPhone} (${mediaType}): "${messageText.substring(0, 80)}"`);

    // Processar via chatbot (async, responde 200 imediatamente)
    handleChatbotMessage({
      remoteJid,
      messageId: data.key?.id || '',
      senderPhone: formattedPhone,
      text: messageText,
      mediaType,
      message: data.message,
    }).catch((err) => console.error('[Webhook] Chatbot error:', err.message));

    res.status(200).json({ status: 'chatbot', phone: formattedPhone });
  } catch (error: any) {
    console.error('[Webhook] Erro:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
