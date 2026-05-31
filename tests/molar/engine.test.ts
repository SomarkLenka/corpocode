import { describe, it, expect } from "vitest";
import { createMolarEditEngine } from "../../src/molar/engine";
import { defaultConfig } from "../../src/config/load";
import type { CorpoConfig, Tenet } from "../../src/config/schema";
import type { ChatOutput, Provider } from "../../src/providers/types";

function provider(impl: () => ChatOutput | Promise<ChatOutput>): Provider {
  return {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    chat: async () => impl(),
    ping: async () => true,
  };
}

const out = (text: string): ChatOutput => ({
  text,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  providerId: "anthropic",
  model: "m",
  finishReason: "stop",
});

function configWith(tenets: Tenet[]): CorpoConfig {
  const config = defaultConfig();
  config.molar_edit = { ...config.molar_edit, active_tenets: tenets };
  return config;
}

describe("MolarEditEngine", () => {
  it("review fans out one reviewer per active tenet", async () => {
    const engine = createMolarEditEngine({
      provider: provider(() => out(JSON.stringify({ ok: false, severity: "warn", message: "concern", confidence: 0.6 }))),
      config: configWith(["M", "A", "T"]),
    });
    const findings = await engine.review("Proposed approach: rewrite the auth flow.");
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.tenet).sort()).toEqual(["A", "M", "T"]);
    expect(findings.every((f) => f.ok === false)).toBe(true);
  });

  it("narrowing active_tenets fires only those lenses", async () => {
    const engine = createMolarEditEngine({
      provider: provider(() => out(JSON.stringify({ ok: true, severity: "info", message: "fine", confidence: 0.9 }))),
      config: configWith(["E"]),
    });
    const findings = await engine.review("approach");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.tenet).toBe("E");
  });

  it("isolates a thrown reviewer to a neutral finding (review never crashes)", async () => {
    const engine = createMolarEditEngine({
      provider: provider(() => {
        throw new Error("provider down");
      }),
      config: configWith(["M", "A"]),
    });
    const findings = await engine.review("approach");
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.ok === true && f.confidence === 0)).toBe(true); // neutral, not a crash
  });

  it("verify runs the active tenet checks over the changed files", async () => {
    const engine = createMolarEditEngine({
      provider: provider(() => out(JSON.stringify({ ok: false, severity: "warn", message: "x", confidence: 0.7 }))),
      config: configWith(["A", "L"]),
      readFile: () => "some code",
    });
    const findings = await engine.verify(["a.ts"]);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.tenet).sort()).toEqual(["A", "L"]);
  });
});
