import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** OpenAI-shaped message, which is what SERV speaks. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface Completion {
  message: ChatMessage;
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Thin client for SERV Reasoning.
 *
 * SERV is OpenAI-shaped, so this is deliberately a small wrapper rather than a
 * framework: messages in, a message or tool calls out. The loop that decides
 * what to do with tool calls lives in AgentService, where it can be read.
 *
 * One SERV-specific rule: every request must carry a system prompt. Omitting
 * it is a 400, not a default — so the caller cannot accidentally send an
 * unguarded conversation to a model that can move money.
 */
@Injectable()
export class ReasoningService {
  private readonly log = new Logger(ReasoningService.name);

  constructor(private readonly config: ConfigService) {}

  async complete(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<Completion> {
    if (messages[0]?.role !== 'system') {
      throw new Error('SERV requires a system prompt as the first message.');
    }

    const base = this.config.get<string>('SERV_API_URL');
    const key = this.config.getOrThrow<string>('OPENSERV_AI_API_KEY');
    const model = this.config.getOrThrow<string>('SERV_MODEL');

    const body = JSON.stringify({
      model,
      max_tokens: 1500,
      messages,
      ...(tools.length ? { tools } : {}),
    });

    // Two attempts. Connect timeouts to this host happen, and one blip turning
    // a whole conversational turn into an error is worse than a second of
    // latency. A 4xx is an answer, not a blip, so it is never retried — that
    // would burn the budget on a request that will fail the same way twice.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body,
        });
        if (res.status >= 400 && res.status < 500) break;
        if (res.ok) break;
        if (attempt === 1) break;
      } catch (err) {
        if (attempt === 1 || signal?.aborted) {
          throw new Error(`SERV unreachable: ${(err as Error).message}`);
        }
        this.log.warn(`SERV attempt failed, retrying: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    if (!res) throw new Error('SERV unreachable.');

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // The key is in a header, never the body, so this is safe to surface.
      throw new Error(`SERV ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: ChatMessage; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices?.[0];
    if (!choice) throw new Error('SERV returned no choices.');

    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: data.usage,
    };
  }
}
