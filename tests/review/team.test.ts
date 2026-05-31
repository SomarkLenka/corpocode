import { describe, it, expect } from "vitest";
import { runDesignReview } from "../../src/review/team";
import { defaultConfig } from "../../src/config/load";
import type { CorpoConfig, Tenet } from "../../src/config/schema";
import type { ChatOutput, Provider } from "../../src/providers/types";

function provider(text: string): Provider {
  return {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    chat: async (): Promise<ChatOutput> => ({
      text,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId: "anthropic",
      model: "m",
      finishReason: "stop",
    }),
    ping: async () => true,
  };
}

function configWith(tenets: Tenet[]): CorpoConfig {
  const config = defaultConfig();
  config.molar_edit = { ...config.molar_edit, active_tenets: tenets };
  return config;
}

describe("design-review team", () => {
  it("emits one review_check per active tenet and injects feedback for concerns", async () => {
    const records: Array<Record<string, unknown>> = [];
    const result = await runDesignReview(
      { sessionId: "s", designContext: "Approach: store auth tokens in localStorage." },
      {
        provider: provider(JSON.stringify({ ok: false, severity: "warn", message: "leaks across XSS", confidence: 0.7 })),
        config: configWith(["M", "T"]),
        logger: { enabled: true, log: (r: Record<string, unknown>) => records.push(r) },
      },
    );
    expect(records.filter((r) => r.event === "review_check")).toHaveLength(2);
    expect(result.feedback).toContain("[M]");
    expect(result.feedback).toContain("[T]");
  });

  it("narrowing the active set fires only those lenses", async () => {
    const records: Array<Record<string, unknown>> = [];
    await runDesignReview(
      { sessionId: "s", designContext: "approach" },
      {
        provider: provider(JSON.stringify({ ok: true, severity: "info", message: "ok", confidence: 0.9 })),
        config: configWith(["E"]),
        logger: { enabled: true, log: (r) => records.push(r) },
      },
    );
    const checks = records.filter((r) => r.event === "review_check");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.tenet).toBe("E");
  });

  it("returns null feedback when every lens is clean", async () => {
    const result = await runDesignReview(
      { sessionId: "s", designContext: "a sound approach" },
      {
        provider: provider(JSON.stringify({ ok: true, severity: "info", message: "fine", confidence: 0.9 })),
        config: configWith(["M", "A"]),
        logger: { enabled: false, log: () => {} },
      },
    );
    expect(result.feedback).toBeNull();
  });
});
