// The LLM boundary. Every cheap-model call in CorpoCode goes through this narrow interface, so
// no architectural code knows which vendor is behind it. Deliberately minimal: a system prompt,
// a short message list, optional structured-JSON output, a few knobs — no streaming, no images.
import type { Pingable, Millis } from "../types/common";

// ProviderKind is defined once in config/schema.ts (config validation needs the runtime enum) and
// re-exported here so provider-layer code imports it from the natural place.
import type { ProviderKind } from "../config/schema";
export type { ProviderKind };

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ChatInput {
  system: string;
  messages: Message[];
  maxTokens?: number;
  responseFormat?: "text" | "json"; // when "json", the returned text is guaranteed to parse as JSON
  jsonSchema?: object; // used when the provider supports schema-constrained output
  temperature?: number; // default 0 — classification should be deterministic
  timeoutMs?: Millis; // default 30000
}

export interface ChatOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // computed locally from pricing.ts, never trusted from the vendor response
  latencyMs: Millis;
  providerId: ProviderKind;
  model: string;
  finishReason: "stop" | "length" | "timeout" | "error";
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "invalid_response"
  | "network"
  | "model_unavailable";

/**
 * One normalized error shape so every component handles failure the same way regardless of which
 * vendor SDK actually threw. `retryable` drives the shared retry policy.
 */
export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly providerId: ProviderKind,
    message: string,
    public readonly retryable: boolean,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider extends Pingable {
  readonly id: ProviderKind;
  readonly model: string;
  readonly modelTier: "fast" | "balanced";
  chat(input: ChatInput): Promise<ChatOutput>;
}
