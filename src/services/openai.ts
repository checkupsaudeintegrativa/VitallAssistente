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
let groqClient: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

function getGroqClient(): OpenAI | null {
  if (!env.GROQ_API_KEY) return null;
  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return groqClient;
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
  const resolvedModel = model || 'gpt-4o-mini';

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
      const maxTokens = isNewModel ? 16384 : 4096;
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
      const usage = response.usage;
      console.log(`[OpenAI] Iter ${i} | modelo: ${response.model} | finish: ${choice.finish_reason} | tokens: ${usage?.total_tokens || '?'} (prompt: ${usage?.prompt_tokens || '?'}, completion: ${usage?.completion_tokens || '?'})`);

      // Detectar resposta cortada (JSON de tool_calls pode estar incompleto)
      if (choice.finish_reason === 'length') {
        console.warn(`[OpenAI] ⚠ Resposta cortada por max_completion_tokens (${maxTokens})! Iteração ${i}`);
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
        } catch (parseErr: any) {
          console.error(`[OpenAI] ⚠ JSON.parse falhou para ${fnName}: ${(fn.arguments || '').substring(0, 200)}...`);
          fnArgs = {};
        }

        // Log truncado para não poluir (chart_config pode ser enorme)
        const argsStr = JSON.stringify(fnArgs);
        console.log(`[OpenAI] Tool call: ${fnName}(${argsStr.substring(0, 300)}${argsStr.length > 300 ? '...' : ''})`);

        const result = await executeTool(fnName, fnArgs, user);

        console.log(`[OpenAI] Tool result (${fnName}): ${result.substring(0, 300)}`);

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
 * Usa Groq (gratuito) se GROQ_API_KEY estiver configurada, senão fallback para OpenAI.
 * Recebe base64 do áudio e o mimetype, retorna texto transcrito.
 */
export async function transcribeAudio(
  base64Audio: string,
  mimetype: string
): Promise<string> {
  const groq = getGroqClient();
  const openai = getClient();
  const client = groq || openai;
  if (!client) {
    return '';
  }

  const provider = groq ? 'Groq' : 'OpenAI';
  const model = groq ? 'whisper-large-v3-turbo' : 'whisper-1';

  try {
    const buffer = Buffer.from(base64Audio, 'base64');
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'webm';
    const file = await toFile(buffer, `audio.${ext}`, { type: mimetype });

    console.log(`[Whisper] Transcrevendo via ${provider} (${model})`);

    const transcription = await client.audio.transcriptions.create({
      model,
      file,
      language: 'pt',
    });

    return transcription.text || '';
  } catch (error: any) {
    console.error(`[Whisper] Erro ao transcrever (${provider}):`, error.message);
    // Fallback: se Groq falhou e tem OpenAI, tenta OpenAI
    if (groq && openai) {
      try {
        console.log('[Whisper] Fallback para OpenAI...');
        const buffer = Buffer.from(base64Audio, 'base64');
        const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'webm';
        const file = await toFile(buffer, `audio.${ext}`, { type: mimetype });
        const transcription = await openai.audio.transcriptions.create({
          model: 'whisper-1',
          file,
          language: 'pt',
        });
        return transcription.text || '';
      } catch (fallbackErr: any) {
        console.error('[Whisper] Fallback OpenAI também falhou:', fallbackErr.message);
      }
    }
    return '';
  }
}
