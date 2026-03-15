import { File } from 'node:buffer';
// Polyfill: Node 18 não tem File como global, mas o SDK OpenAI exige
if (!globalThis.File) {
  (globalThis as any).File = File;
}

import OpenAI, { toFile } from 'openai';
import { env } from '../config/env';
import { executeTool, getToolsForUser, ToolDefinition } from './ai-tools';
import { UserConfig } from '../config/users';

let client: OpenAI | null = null;
let financialClient: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

function getFinancialClient(): OpenAI | null {
  if (!env.OPENAI_FINANCIAL_API_KEY) return null;
  if (!financialClient) {
    financialClient = new OpenAI({ apiKey: env.OPENAI_FINANCIAL_API_KEY });
  }
  return financialClient;
}

// ── Chatbot AI ──

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string }; file?: { filename: string; file_data: string } }>;
}

/**
 * Envia conversa para GPT-4o com function calling (tools).
 * Loop: envia messages+tools -> executa tool_calls -> reenvia resultados -> repete (máx 5 iterações).
 * Suporta visão (imagens) quando imageBase64/mimeType são fornecidos.
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  imageBase64?: string,
  mimeType?: string,
  user?: UserConfig | null,
  model?: string
): Promise<string> {
  // Se o modelo não é gpt-4o e tem key financeira, usa o client financeiro
  const useFinancial = model && model !== 'gpt-4o' && !!env.OPENAI_FINANCIAL_API_KEY;
  const openai = useFinancial ? getFinancialClient() : getClient();
  if (!openai) {
    return 'Desculpe, estou temporariamente indisponível. Por favor, tente novamente em alguns minutos.';
  }
  const resolvedModel = model || 'gpt-4o';

  try {
    // Se há imagem/PDF, adiciona ao último user message como conteúdo multimodal
    const finalMessages: any[] = [...messages];
    if (imageBase64 && mimeType) {
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        const textContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';
        const isPdf = mimeType === 'application/pdf';

        const mediaPart = isPdf
          ? {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: `data:application/pdf;base64,${imageBase64}`,
              },
            }
          : {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            };

        lastMsg.content = [
          { type: 'text', text: textContent || (isPdf ? 'Documento PDF enviado:' : 'Imagem enviada:') },
          mediaPart,
        ];
      }
    }

    const MAX_TOOL_ITERATIONS = 5;
    // Se tools não foram passados como parâmetro, usa o filtro por usuário (fallback legado)
    const resolvedTools = tools || getToolsForUser(user);

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (i === 0) {
        console.log(`[OpenAI] Modelo: ${resolvedModel} | Client: ${useFinancial ? 'financeiro' : 'padrão'}`);
      }

      // Modelos gpt-5.x usam max_completion_tokens; gpt-4o usa max_tokens
      const isNewModel = resolvedModel.startsWith('gpt-5') || resolvedModel.startsWith('o');
      const maxTokens = isNewModel ? 4096 : 2000;
      const response = await openai.chat.completions.create({
        model: resolvedModel,
        temperature: 0.4,
        ...(isNewModel ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        messages: finalMessages,
        tools: resolvedTools as any,
        tool_choice: 'auto',
      } as any);

      const choice = response.choices[0];
      const message = choice.message;

      // Log do modelo real retornado pela API + tokens usados
      if (i === 0) {
        const usage = response.usage;
        console.log(`[OpenAI] Resposta modelo: ${response.model} | Tokens: ${usage?.total_tokens || '?'} (prompt: ${usage?.prompt_tokens || '?'}, completion: ${usage?.completion_tokens || '?'})`);
      }

      // Se não tem tool_calls, retorna o texto final
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content?.trim() || 'Desculpe, não consegui processar sua mensagem.';
      }

      // Adiciona a mensagem do assistente (com tool_calls) ao histórico
      finalMessages.push(message);

      // Executa cada tool_call e adiciona os resultados
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fn = (toolCall as any).function as { name: string; arguments: string };
        const fnName = fn.name;
        let fnArgs: Record<string, any> = {};
        try {
          fnArgs = JSON.parse(fn.arguments || '{}');
        } catch {
          fnArgs = {};
        }

        console.log(`[OpenAI] Tool call: ${fnName}(${JSON.stringify(fnArgs)})`);

        const result = await executeTool(fnName, fnArgs, user);

        console.log(`[OpenAI] Tool result (${fnName}): ${result.substring(0, 200)}`);

        finalMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // Se chegou aqui, excedeu o máximo de iterações
    return 'Desculpe, a consulta ficou muito complexa. Tente ser mais específica na pergunta.';
  } catch (error: any) {
    console.error('[OpenAI] Erro no chatWithTools:', error.message);
    return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente em instantes.';
  }
}

/**
 * Transcreve áudio via Whisper API.
 * Recebe base64 do áudio e o mimetype, retorna texto transcrito.
 */
export async function transcribeAudio(
  base64Audio: string,
  mimetype: string
): Promise<string> {
  const openai = getClient();
  if (!openai) {
    return '';
  }

  try {
    // Converte base64 para Buffer e usa toFile do SDK (compatível com Node 18)
    const buffer = Buffer.from(base64Audio, 'base64');
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'webm';
    const file = await toFile(buffer, `audio.${ext}`, { type: mimetype });

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'pt',
    });

    return transcription.text || '';
  } catch (error: any) {
    console.error('[OpenAI] Erro ao transcrever áudio:', error.message);
    return '';
  }
}
