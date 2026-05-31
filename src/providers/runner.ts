// The cross-cutting heart of every provider: timeout (race + abort), bounded jittered retry,
// local cost computation, JSON-contract enforcement, and ProviderError normalization. Each adapter
// supplies only a thin `RawChat` seam; this runner owns everything that must behave identically
// across vendors — which is exactly what the conformance suite pins down.
import type { ChatInput, ChatOutput, ProviderKind } from "./types";
import { ProviderError } from "./types";
import type { Millis, RetryPolicy } from "../types/common";
import { computeCostUsd } from "./pricing";

/** The normalized result an adapter's raw call returns; the runner wraps it into a ChatOutput. */
export interface RawResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: "stop" | "length" | "error";
  model: string;
}

/** The single per-adapter seam. Must throw ProviderError on failure (use mapVendorError). */
export type RawChat = (input: ChatInput, signal: AbortSignal) => Promise<RawResult>;

export interface RunnerConfig {
  providerId: ProviderKind;
  model: string;
  retry: RetryPolicy;
  // Injectable for deterministic, fast tests:
  now?: () => number;
  sleep?: (ms: Millis) => Promise<void>;
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, retry: RetryPolicy, random: () => number): number {
  const exp = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return retry.jitter ? Math.floor(exp * random()) : exp;
}

async function withTimeout(
  raw: RawChat,
  input: ChatInput,
  timeoutMs: number,
  providerId: ProviderKind,
): Promise<RawResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE aborting: aborting can synchronously settle the raw call (e.g. a test seam
      // that resolves on abort, or a real SDK that throws AbortError), and the timeout must win
      // the race. Promise.race adopts the first settlement, so the order here matters.
      reject(new ProviderError("timeout", providerId, `provider call exceeded ${timeoutMs}ms`, true));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([raw(input, controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Strip markdown fences and isolate the JSON value; return a parseable JSON string or null.
 * Makes the responseFormat:"json" contract hold even when a model wraps output in prose/fences.
 */
export function extractJson(text: string): string | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const tryParse = (s: string): string | null => {
    try {
      JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stripped);
  if (direct !== null) return direct;

  const candidates = [stripped.indexOf("{"), stripped.indexOf("[")].filter((i) => i >= 0);
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates);
  const end = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
  if (end <= start) return null;
  return tryParse(stripped.slice(start, end + 1));
}

function asProviderError(err: unknown, providerId: ProviderKind): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError("invalid_response", providerId, message, false, err);
}

export async function runChat(raw: RawChat, input: ChatInput, cfg: RunnerConfig): Promise<ChatOutput> {
  const now = cfg.now ?? (() => Date.now());
  const sleep = cfg.sleep ?? defaultSleep;
  const random = cfg.random ?? Math.random;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = now();
  let lastErr: ProviderError | undefined;

  for (let attempt = 1; attempt <= cfg.retry.maxAttempts; attempt++) {
    try {
      const result = await withTimeout(raw, input, timeoutMs, cfg.providerId);
      let text = result.text;
      if (input.responseFormat === "json") {
        const cleaned = extractJson(text);
        if (cleaned === null) {
          throw new ProviderError(
            "invalid_response",
            cfg.providerId,
            "expected JSON but the response did not parse",
            false,
            text,
          );
        }
        text = cleaned;
      }
      const model = result.model || cfg.model;
      return {
        text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: computeCostUsd(cfg.providerId, model, result.inputTokens, result.outputTokens),
        latencyMs: now() - start,
        providerId: cfg.providerId,
        model,
        finishReason: result.finishReason,
      };
    } catch (err) {
      const pe = asProviderError(err, cfg.providerId);
      lastErr = pe;
      const retryable = pe.retryable && cfg.retry.retryableKinds.includes(pe.kind);
      if (!retryable || attempt >= cfg.retry.maxAttempts) throw pe;
      await sleep(backoffDelay(attempt, cfg.retry, random));
    }
  }
  throw lastErr ?? new ProviderError("network", cfg.providerId, "no attempts made", false);
}
