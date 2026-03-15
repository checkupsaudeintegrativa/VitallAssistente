import { EdgeTTS } from 'node-edge-tts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VOICE = 'pt-BR-AntonioNeural'; // Masculina, jovem
const MAX_TEXT_LENGTH = 2000; // ~1-2 min de áudio

/**
 * Gera áudio MP3 a partir de texto usando Edge TTS (gratuito).
 * Retorna Buffer MP3 pronto para enviar via Evolution API.
 */
export async function generateAudio(text: string): Promise<Buffer> {
  const truncated = text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH) + '...'
    : text;

  const tmpFile = path.join(os.tmpdir(), `vitall-tts-${Date.now()}.mp3`);

  try {
    const tts = new EdgeTTS({ voice: VOICE, lang: 'pt-BR' });
    await tts.ttsPromise(truncated, tmpFile);
    const buffer = fs.readFileSync(tmpFile);
    return buffer;
  } finally {
    // Limpa arquivo temporário
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
