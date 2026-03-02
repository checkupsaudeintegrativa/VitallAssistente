import { Router, Request, Response } from 'express';
import { formatPhoneBR } from '../utils/phone';
import { handleChatbotMessage, IncomingMessage } from '../services/chatbot';

const router = Router();

/** Números autorizados a usar a IA */
const ALLOWED_PHONES = [
  '5511934550921',  // Jéssica (principal)
  '5511943635555',  // Arthur
  '5511917293419',  // Jéssica (segundo número)
  '5511944655555',  // Dra. Ana
];

/** Mapa de telefone → nome da pessoa (para a IA chamar pelo nome certo) */
const PHONE_NAMES: Record<string, string> = {
  '5511934550921': 'Jéssica',
  '5511943635555': 'Arthur',
  '5511917293419': 'Jéssica',
  '5511944655555': 'Dra. Ana',
};

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

    // Detecta se é um LID (Linked ID) — WhatsApp pessoal usa IDs opacos
    const isLid = remoteJid.endsWith('@lid');

    // Extrai número do remetente (remove @s.whatsapp.net, @c.us ou @lid)
    const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
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

    // Verifica autorização:
    // - Números @s.whatsapp.net/@c.us: verifica na lista ALLOWED_PHONES
    // - Números @lid (WhatsApp pessoal): permite (LID é opaco, não dá pra mapear)
    if (!isLid && !ALLOWED_PHONES.includes(formattedPhone)) {
      console.log(`[Webhook] Número não autorizado: ${formattedPhone}, ignorando`);
      res.status(200).json({ status: 'ignored', reason: 'unauthorized phone' });
      return;
    }

    // Para LID: mapeia pelo pushName ou usa JESSICA_PHONE como fallback
    // LID é opaco e não é telefone real — precisamos de um phone válido para histórico e lembretes
    let resolvedPhone = formattedPhone;
    if (isLid) {
      const pushName = (data.pushName || '').toLowerCase();
      if (pushName.includes('arthur')) {
        resolvedPhone = '5511943635555';
      } else if (pushName.includes('ana')) {
        resolvedPhone = '5511944655555';
      } else if (pushName.includes('jéssica') || pushName.includes('jessica')) {
        resolvedPhone = '5511934550921';
      } else {
        resolvedPhone = process.env.JESSICA_PHONE || '5511934550921';
      }
      console.log(`[Webhook] Mensagem via LID: ${senderPhone} → mapeado para ${resolvedPhone} (pushName: "${data.pushName || 'N/A'}")`);
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

    console.log(`[Webhook] Mensagem de ${resolvedPhone} (${mediaType}): "${messageText.substring(0, 80)}"`);

    // Resolver nome da pessoa pelo telefone
    const senderName = PHONE_NAMES[resolvedPhone] || data.pushName || 'Usuário';

    // Processar via chatbot (async, responde 200 imediatamente)
    handleChatbotMessage({
      remoteJid,
      messageId: data.key?.id || '',
      senderPhone: resolvedPhone,
      senderName,
      text: messageText,
      mediaType,
      message: data.message,
    }).catch((err) => console.error('[Webhook] Chatbot error:', err.message));

    res.status(200).json({ status: 'chatbot', phone: resolvedPhone });
  } catch (error: any) {
    console.error('[Webhook] Erro:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
