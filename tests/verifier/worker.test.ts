import { describe, it, expect } from "vitest";
import { runChecks } from "../../src/verifier/worker";
import { ALL_CHECKS, checksForTenets } from "../../src/verifier/tenets";
import type { TenetCheck } from "../../src/molar/types";
import type { ChatOutput, Provider } from "../../src/providers/types";

function provider(text: string): Provider {
  return {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    async chat(): Promise<ChatOutput> {
      return {
        text,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        providerId: "anthropic",
        model: "m",
        finishReason: "stop",
      };
    },
    async ping() {
      return true;
    },
  };
}

describe("verifier runChecks", () => {
  it("runs every applicable tenet check on a source file (R excluded for non-UI)", async () => {
    const findings = await runChecks(ALL_CHECKS, {
      files: ["a.ts"],
      provider: provider(JSON.stringify({ ok: false, severity: "warn", message: "does too much", confidence: 0.8 })),
      readFile: () => "some source code",
    });
    // M, O, L, A, E, D, I, T apply to a .ts file; R (Responsiveness) is UI-only and is skipped.
    expect(findings).toHaveLength(8);
    expect(findings.map((f) => f.tenet)).not.toContain("R");
    expect(findings.every((f) => f.ok === false)).toBe(true);
  });

  it("fires Responsiveness only on a UI file", async () => {
    const findings = await runChecks(checksForTenets(["R"]), {
      files: ["Button.tsx"],
      provider: provider(JSON.stringify({ ok: true, severity: "info", message: "fine", confidence: 0.9 })),
      readFile: () => "<button>",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.tenet).toBe("R");
  });

  it("skips a file no tenet applies to", async () => {
    const findings = await runChecks(ALL_CHECKS, {
      files: ["logo.png"],
      provider: provider("{}"),
      readFile: () => "binary",
    });
    expect(findings).toHaveLength(0);
  });

  it("degrades a garbage response to a neutral finding without affecting others", async () => {
    const check: TenetCheck = { tenet: "A", name: "a", appliesTo: () => true, prompt: "p" };
    const findings = await runChecks([check], {
      files: ["a.ts"],
      provider: provider("not valid json"),
      readFile: () => "code",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ok).toBe(true); // neutral, never a false block
    expect(findings[0]!.confidence).toBe(0);
  });

  it("removing a tenet from the active set stops its check", async () => {
    const findings = await runChecks(checksForTenets(["A"]), {
      files: ["a.ts"],
      provider: provider(JSON.stringify({ ok: false, severity: "warn", message: "x", confidence: 0.5 })),
      readFile: () => "code",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.tenet).toBe("A");
  });

  it("skips files that cannot be read", async () => {
    const findings = await runChecks(ALL_CHECKS, {
      files: ["gone.ts"],
      provider: provider("{}"),
      readFile: () => null,
    });
    expect(findings).toHaveLength(0);
  });
});
