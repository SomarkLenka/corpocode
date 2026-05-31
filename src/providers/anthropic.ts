// Anthropic adapter (default Haiku). Structured output via a JSON instruction + the runner's
// extractJson. The real SDK call is lazy and only runs in production; tests inject `rawChat`.
import type { Provider } from "./types";
import { ProviderError } from "./types";
import { jsonSystemPrompt, makeProvider, type AdapterOptions } from "./base";
import type { RawChat, RawResult } from "./runner";
import { mapVendorError } from "./errors";

const PROVIDER_ID = "anthropic" as const;
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function mapStopReason(reason: unknown): "stop" | "length" | "error" {
  return reason === "max_tokens" ? "length" : "stop";
}

/** Normalize the Anthropic Messages response to a RawResult. Exported for direct unit testing. */
export function parseAnthropicResponse(resp: unknown, fallbackModel: string): RawResult {
  const r = (resp ?? {}) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: unknown;
    model?: string;
  };
  const text = (r.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return {
    text,
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    finishReason: mapStopReason(r.stop_reason),
    model: r.model ?? fallbackModel,
  };
}

function defaultRawChat(opts: AdapterOptions): RawChat {
  return async (input, signal) => {
    if (!opts.apiKey) {
      throw new ProviderError("auth", PROVIDER_ID, "ANTHROPIC_API_KEY is not configured", false);
    }
    try {
      // Vendor seam: typed loosely on purpose so a patch-level SDK type change cannot break our
      // typecheck. Normalized to RawResult immediately. (Justified boundary `any`.)
      const mod: any = await import("@anthropic-ai/sdk");
      const Anthropic = mod.default ?? mod.Anthropic;
      const client = new Anthropic({ apiKey: opts.apiKey });
      const resp = await client.messages.create(
        {
          model: opts.model,
          max_tokens: input.maxTokens ?? 1024,
          temperature: input.temperature ?? 0,
          system: jsonSystemPrompt(input),
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal },
      );
      return parseAnthropicResponse(resp, opts.model);
    } catch (err) {
      throw mapVendorError(err, PROVIDER_ID);
    }
  };
}

export function createAnthropicProvider(opts: AdapterOptions): Provider {
  const model = opts.model || DEFAULT_ANTHROPIC_MODEL;
  return makeProvider({
    id: PROVIDER_ID,
    model,
    modelTier: "fast",
    rawChat: opts.rawChat ?? defaultRawChat({ ...opts, model }),
    rawPing: opts.rawPing,
    retry: opts.retry,
    now: opts.now,
    sleep: opts.sleep,
    random: opts.random,
  });
}
