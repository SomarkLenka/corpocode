// OpenRouter adapter — a thin extension of the OpenAI adapter (same client, different base URL and
// model defaults), since OpenRouter speaks an OpenAI-compatible protocol. Roughly halves the
// maintenance surface for two providers.
import type { Provider } from "./types";
import { makeProvider, type AdapterOptions } from "./base";
import { buildOpenAiRawChat } from "./openai";

const PROVIDER_ID = "openrouter" as const;
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-haiku";

export function createOpenRouterProvider(opts: AdapterOptions): Provider {
  const model = opts.model || DEFAULT_OPENROUTER_MODEL;
  const baseUrl = opts.baseUrl || DEFAULT_OPENROUTER_BASE_URL;
  return makeProvider({
    id: PROVIDER_ID,
    model,
    modelTier: "fast",
    rawChat: opts.rawChat ?? buildOpenAiRawChat({ ...opts, model, baseUrl }, PROVIDER_ID, baseUrl),
    rawPing: opts.rawPing,
    retry: opts.retry,
    now: opts.now,
    sleep: opts.sleep,
    random: opts.random,
  });
}
