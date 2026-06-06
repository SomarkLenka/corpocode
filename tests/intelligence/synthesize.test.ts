import { describe, it, expect } from "vitest";
import { synthesize } from "../../src/intelligence/synthesize";
import { TAGS } from "../../src/hooks/response";
import type { OrchestrationResult, AgentTaskResult } from "../../src/intelligence/types";

const ok = (id: string, payload: { text?: string; data?: unknown }): AgentTaskResult => ({
  id,
  result: {
    ok: true,
    text: payload.text,
    data: payload.data,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, model: "m" },
    model: { providerKey: "p", model: "m" },
  },
});

const resultOf = (tasks: AgentTaskResult[]): OrchestrationResult => ({
  ok: tasks.length > 0,
  tasks,
  usage: { costUsd: 0, latencyMs: 1, calls: tasks.length, succeeded: tasks.length },
});

describe("synthesize — one tagged injection", () => {
  it("wraps surviving tasks under the IntelligentRouter tag, preferring prose", () => {
    const out = synthesize(resultOf([ok("a.ts", { text: "implicated at line 5" })]));
    expect(out.startsWith(`<${TAGS.intelligentRouter}>`)).toBe(true);
    expect(out).toContain("## a.ts");
    expect(out).toContain("implicated at line 5");
  });

  it("renders structured data as JSON when there is no prose", () => {
    const out = synthesize(resultOf([ok("b.ts", { data: { implicated: true } })]));
    expect(out).toContain('"implicated": true');
  });

  it("returns '' when nothing survived (no-op / fail-open)", () => {
    expect(synthesize(resultOf([]))).toBe("");
  });

  it("returns '' when every task lacked usable output", () => {
    const empty = ok("c.ts", {});
    expect(synthesize(resultOf([empty]))).toBe("");
  });

  it("honours a custom tag and an optional header", () => {
    const out = synthesize(resultOf([ok("a", { text: "x" })]), { tag: "custom", header: "lead line" });
    expect(out.startsWith("<custom>")).toBe(true);
    expect(out).toContain("lead line");
  });
});
