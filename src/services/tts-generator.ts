import { EdgeTTS } from 'node-edge-tts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VOICE = 'pt-BR-AntonioNeural'; // Masculina, jovem

/**
 * Gera áudio MP3 a partir de texto usando Edge TTS (gratuito).
 * Retorna Buffer MP3 pronto para enviar via Evolution API.
 * O texto já deve vir dividido em chunks curtos (~500 chars) por splitTextForAudio().
 */
export async function generateAudio(text: string): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `vitall-tts-${Date.now()}.mp3`);

  try {
    const tts = new EdgeTTS({ voice: VOICE, lang: 'pt-BR' });
    await tts.ttsPromise(text, tmpFile);
    const buffer = fs.readFileSync(tmpFile);
    return buffer;
  } finally {
    // Limpa arquivo temporário
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
