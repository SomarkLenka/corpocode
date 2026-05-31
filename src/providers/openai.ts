// OpenAI adapter (default gpt-5-nano, fallback gpt-4o-mini). The raw-call builder is exported so
// the OpenRouter adapter — an OpenAI-compatible protocol — can reuse it with a different base URL.
import type { Provider, ProviderKind } from "./types";
import { ProviderError } from "./types";
import { jsonSystemPrompt, makeProvider, type AdapterOptions } from "./base";
import type { RawChat, RawResult } from "./runner";
import { mapVendorError } from "./errors";

const PROVIDER_ID = "openai" as const;
export const DEFAULT_OPENAI_MODEL = "gpt-5-nano";

function mapFinish(reason: unknown): "stop" | "length" | "error" {
  return reason === "length" ? "length" : "stop";
}

/** Normalize an OpenAI chat-completions response. Exported for direct unit testing. */
export function parseOpenAiResponse(resp: unknown, fallbackModel: string): RawResult {
  const r = (resp ?? {}) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const choice = r.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    inputTokens: r.usage?.prompt_tokens ?? 0,
    outputTokens: r.usage?.completion_tokens ?? 0,
    finishReason: mapFinish(choice?.finish_reason),
    model: r.model ?? fallbackModel,
  };
}

/** Build a RawChat against any OpenAI-compatible endpoint (OpenAI, OpenRouter, …). */
export function buildOpenAiRawChat(
  opts: AdapterOptions,
  providerId: ProviderKind,
  baseUrl?: string,
): RawChat {
  return async (input, signal) => {
    if (!opts.apiKey) {
      throw new ProviderError("auth", providerId, `${providerId} API key is not configured`, false);
    }
    try {
      // Vendor seam — loosely typed boundary, normalized immediately. (Justified boundary `any`.)
      const mod: any = await import("openai");
      const OpenAI = mod.default ?? mod.OpenAI;
      const client = new OpenAI({ apiKey: opts.apiKey, baseURL: baseUrl });
      const resp = await client.chat.completions.create(
        {
          model: opts.model,
          max_tokens: input.maxTokens,
          temperature: input.temperature ?? 0,
          response_format: input.responseFormat === "json" ? { type: "json_object" } : undefined,
          messages: [
            { role: "system", content: jsonSystemPrompt(input) },
            ...input.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal },
      );
      return parseOpenAiResponse(resp, opts.model);
    } catch (err) {
      throw mapVendorError(err, providerId);
    }
  };
}

export function createOpenAiProvider(opts: AdapterOptions): Provider {
  const model = opts.model || DEFAULT_OPENAI_MODEL;
  return makeProvider({
    id: PROVIDER_ID,
    model,
    modelTier: "fast",
    rawChat: opts.rawChat ?? buildOpenAiRawChat({ ...opts, model }, PROVIDER_ID, opts.baseUrl),
    rawPing: opts.rawPing,
    retry: opts.retry,
    now: opts.now,
    sleep: opts.sleep,
    random: opts.random,
  });
}
