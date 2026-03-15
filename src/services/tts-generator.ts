import { tts } from 'edge-tts';

const VOICE = 'pt-BR-FranciscaNeural'; // Feminina, natural
const MAX_TEXT_LENGTH = 2000; // ~1-2 min de áudio

/**
 * Gera áudio MP3 a partir de texto usando Edge TTS (gratuito).
 * Retorna Buffer MP3 pronto para enviar via Evolution API.
 */
export async function generateAudio(text: string): Promise<Buffer> {
  // Trunca texto longo para manter áudios curtos
  const truncated = text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH) + '...'
    : text;

  const audioBuffer = await tts(truncated, { voice: VOICE });
  return audioBuffer;
}
