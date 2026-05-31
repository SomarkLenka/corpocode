// Shared provider factory. Every adapter differs only in (id, tier, how it makes a raw call); the
// timeout/retry/cost/JSON behavior is identical and lives in the runner. This keeps the
// conformance-critical logic in exactly one place and the adapters thin (A — atomicity).
import type { ChatInput, Provider, ProviderKind } from "./types";
import { DEFAULT_RETRY, type RetryPolicy, type Millis } from "../types/common";
import { runChat, type RawChat, type RunnerConfig } from "./runner";

/**
 * Build the system prompt for vendors without a native JSON mode (anthropic, ollama, cli). When
 * JSON output is requested we instruct the model to emit only JSON; the runner's extractJson then
 * makes the contract hold even if the model adds fences. Vendors with a real JSON mode (openai,
 * google) still pass through this — the extra nudge is harmless and reinforces the constraint.
 */
export function jsonSystemPrompt(input: ChatInput): string {
  if (input.responseFormat !== "json") return input.system;
  const schemaHint = input.jsonSchema
    ? ` It must conform to this JSON schema: ${JSON.stringify(input.jsonSchema)}.`
    : "";
  const nudge = `Respond with ONLY a single valid JSON value — no prose, no markdown code fences.${schemaHint}`;
  return input.system ? `${input.system}\n\n${nudge}` : nudge;
}

/** Options every adapter accepts. The raw* and timing fields are seams the tests inject. */
export interface AdapterOptions {
  model: string;
  apiKey?: string;
  host?: string; // ollama loopback / custom host
  baseUrl?: string; // openrouter / OpenAI-compatible base URL
  retry?: RetryPolicy;
  // Test seams — when provided they replace real I/O so the suite needs no network:
  rawChat?: RawChat;
  rawPing?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: Millis) => Promise<void>;
  random?: () => number;
}

export interface BaseProviderOptions {
  id: ProviderKind;
  model: string;
  modelTier: "fast" | "balanced";
  rawChat: RawChat;
  rawPing?: () => Promise<boolean>;
  retry?: RetryPolicy;
  now?: () => number;
  sleep?: (ms: Millis) => Promise<void>;
  random?: () => number;
}

export function makeProvider(o: BaseProviderOptions): Provider {
  const runnerCfg = (retry: RetryPolicy): RunnerConfig => ({
    providerId: o.id,
    model: o.model,
    retry,
    now: o.now,
    sleep: o.sleep,
    random: o.random,
  });

  return {
    id: o.id,
    model: o.model,
    modelTier: o.modelTier,
    chat: (input) => runChat(o.rawChat, input, runnerCfg(o.retry ?? DEFAULT_RETRY)),
    ping: async () => {
      if (o.rawPing) return o.rawPing();
      // Default probe: a single-attempt, 1-token call. doctor uses this as the "genuine
      // one-token test call" for provider reachability.
      try {
        await runChat(
          o.rawChat,
          { system: "", messages: [{ role: "user", content: "ping" }], maxTokens: 1, timeoutMs: 5_000 },
          runnerCfg({ ...DEFAULT_RETRY, maxAttempts: 1 }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
