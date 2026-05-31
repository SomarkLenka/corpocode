// Ollama adapter — local loopback, no auth, cost always 0 (computed in pricing.ts). Default host
// is http://localhost:11434; the model is user-selected (e.g. qwen2.5-coder:7b).
import type { Provider } from "./types";
import { makeProvider, jsonSystemPrompt, type AdapterOptions } from "./base";
import type { RawChat, RawResult } from "./runner";
import { mapVendorError } from "./errors";

const PROVIDER_ID = "ollama" as const;
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

/** Normalize an Ollama chat response. Exported for direct unit testing. */
export function parseOllamaResponse(resp: unknown, fallbackModel: string): RawResult {
  const r = (resp ?? {}) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    done?: boolean;
    done_reason?: string;
    model?: string;
  };
  return {
    text: r.message?.content ?? "",
    inputTokens: r.prompt_eval_count ?? 0,
    outputTokens: r.eval_count ?? 0,
    finishReason: r.done_reason === "length" ? "length" : "stop",
    model: r.model ?? fallbackModel,
  };
}

function defaultRawChat(opts: AdapterOptions): RawChat {
  return async (input) => {
    try {
      // Vendor seam — loosely typed boundary, normalized immediately. (Justified boundary `any`.)
      const mod: any = await import("ollama");
      const Ollama = mod.Ollama ?? mod.default?.Ollama;
      const client = new Ollama({ host: opts.host ?? DEFAULT_OLLAMA_HOST });
      const resp = await client.chat({
        model: opts.model,
        stream: false,
        format: input.responseFormat === "json" ? "json" : undefined,
        options: { temperature: input.temperature ?? 0, num_predict: input.maxTokens },
        messages: [
          { role: "system", content: jsonSystemPrompt(input) },
          ...input.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      });
      return parseOllamaResponse(resp, opts.model);
    } catch (err) {
      throw mapVendorError(err, PROVIDER_ID);
    }
  };
}

export function createOllamaProvider(opts: AdapterOptions): Provider {
  return makeProvider({
    id: PROVIDER_ID,
    model: opts.model,
    modelTier: "fast",
    rawChat: opts.rawChat ?? defaultRawChat(opts),
    rawPing: opts.rawPing,
    retry: opts.retry,
    now: opts.now,
    sleep: opts.sleep,
    random: opts.random,
  });
}
