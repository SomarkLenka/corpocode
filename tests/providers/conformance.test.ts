// One contract, run against every adapter. Adding a seventh provider later means passing this
// suite, not writing a new one. Each scenario injects a controllable `rawChat` so no network or
// SDK is touched — what's under test is that every adapter routes through the shared runner and so
// inherits identical timeout / retry / cost / JSON behavior.
import { describe, it, expect } from "vitest";
import type { Provider, ProviderKind } from "../../src/providers/types";
import { ProviderError } from "../../src/providers/types";
import type { RawChat, RawResult } from "../../src/providers/runner";
import type { AdapterOptions } from "../../src/providers/base";
import { computeCostUsd } from "../../src/providers/pricing";
import { createAnthropicProvider } from "../../src/providers/anthropic";
import { createAnthropicCliProvider } from "../../src/providers/anthropic-cli";
import { createGoogleProvider } from "../../src/providers/google";
import { createOpenAiProvider } from "../../src/providers/openai";
import { createOpenRouterProvider } from "../../src/providers/openrouter";
import { createOllamaProvider } from "../../src/providers/ollama";

const fast = { sleep: async () => {}, now: () => 0, random: () => 0 } satisfies Partial<AdapterOptions>;

const baseInput = {
  system: "you are a classifier",
  messages: [{ role: "user" as const, content: "hello" }],
};

const okRaw = (over: Partial<RawResult> = {}): RawChat => async () => ({
  text: "hello",
  inputTokens: 10,
  outputTokens: 20,
  finishReason: "stop",
  model: "",
  ...over,
});

// Delays past any sane timeout but resolves harmlessly on abort, so the losing race promise never
// produces an unhandled rejection.
const slowRaw: RawChat = (_input, signal) =>
  new Promise<RawResult>((resolve) => {
    const dummy: RawResult = { text: "", inputTokens: 0, outputTokens: 0, finishReason: "stop", model: "" };
    const t = setTimeout(() => resolve({ ...dummy, text: "late" }), 50);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve(dummy);
      },
      { once: true },
    );
  });

interface AdapterDescriptor {
  name: string;
  id: ProviderKind;
  defaultModel: string;
  make: (over: Partial<AdapterOptions>) => Provider;
}

function descriptor(
  name: string,
  id: ProviderKind,
  defaultModel: string,
  create: (o: AdapterOptions) => Provider,
): AdapterDescriptor {
  return {
    name,
    id,
    defaultModel,
    make: (over) => create({ model: defaultModel, apiKey: "test-key", ...fast, ...over }),
  };
}

const ADAPTERS: AdapterDescriptor[] = [
  descriptor("anthropic", "anthropic", "claude-haiku-4-5-20251001", createAnthropicProvider),
  descriptor("anthropic-cli", "anthropic-cli", "claude-haiku-4-5", createAnthropicCliProvider),
  descriptor("google", "google", "gemini-2.5-flash", createGoogleProvider),
  descriptor("openai", "openai", "gpt-5-nano", createOpenAiProvider),
  descriptor("openrouter", "openrouter", "anthropic/claude-3.5-haiku", createOpenRouterProvider),
  descriptor("ollama", "ollama", "qwen2.5-coder:7b", createOllamaProvider),
];

describe.each(ADAPTERS)("provider conformance: $name", (d) => {
  it("returns non-empty text, token counts, and provenance", async () => {
    const out = await d.make({ rawChat: okRaw() }).chat(baseInput);
    expect(out.text).toBe("hello");
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(20);
    expect(out.providerId).toBe(d.id);
    expect(out.model).toBe(d.defaultModel);
    expect(out.finishReason).toBe("stop");
    expect(typeof out.latencyMs).toBe("number");
  });

  it("returns parseable JSON in json mode, stripping code fences", async () => {
    const out = await d
      .make({ rawChat: okRaw({ text: '```json\n{"ok":true}\n```' }) })
      .chat({ ...baseInput, responseFormat: "json" });
    expect(JSON.parse(out.text)).toEqual({ ok: true });
  });

  it("raises a retryable timeout ProviderError for timeoutMs:1", async () => {
    await expect(d.make({ rawChat: slowRaw }).chat({ ...baseInput, timeoutMs: 1 })).rejects.toMatchObject(
      { kind: "timeout", retryable: true },
    );
  });

  it("raises a non-retryable auth ProviderError and does not retry", async () => {
    let calls = 0;
    const p = d.make({
      rawChat: async () => {
        calls++;
        throw new ProviderError("auth", d.id, "invalid key", false);
      },
    });
    await expect(p.chat(baseInput)).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(calls).toBe(1);
  });

  it("retries a retryable error then succeeds", async () => {
    let calls = 0;
    const p = d.make({
      rawChat: async () => {
        calls++;
        if (calls < 3) throw new ProviderError("rate_limit", d.id, "429", true);
        return { text: "ok", inputTokens: 1, outputTokens: 1, finishReason: "stop", model: "" };
      },
    });
    const out = await p.chat(baseInput);
    expect(out.text).toBe("ok");
    expect(calls).toBe(3);
  });

  it("computes costUsd from the pricing table for known token counts", async () => {
    const out = await d.make({ rawChat: okRaw({ inputTokens: 1000, outputTokens: 2000 }) }).chat(baseInput);
    expect(out.costUsd).toBeCloseTo(computeCostUsd(d.id, d.defaultModel, 1000, 2000), 10);
  });

  it("ping reflects health", async () => {
    expect(await d.make({ rawChat: okRaw() }).ping()).toBe(true);
    expect(
      await d
        .make({
          rawChat: async () => {
            throw new ProviderError("network", d.id, "down", true);
          },
        })
        .ping(),
    ).toBe(false);
  });
});
