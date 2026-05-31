import { describe, it, expect } from "vitest";
import { stageTwo } from "../../src/router/ranker";
import { routerDecisionSchema } from "../../src/router/output-schema";
import type { ChatOutput, Provider } from "../../src/providers/types";
import type { ScoredFile } from "../../src/backends/graph/types";
import type { ThoughtState } from "../../src/session/types";

const thought: ThoughtState = { intent: "", openQuestions: [], recentDecisions: [], entities: [] };
const candidates: ScoredFile[] = [
  { path: "a.ts", score: 0.9, nodeId: "a" },
  { path: "b.ts", score: 0.5, nodeId: "b" },
];

function textProvider(text: string): Provider {
  return {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    async chat(): Promise<ChatOutput> {
      return {
        text,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.0001,
        latencyMs: 5,
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

const throwingProvider: Provider = {
  id: "anthropic",
  model: "m",
  modelTier: "fast",
  async chat() {
    throw new Error("no key");
  },
  async ping() {
    return true;
  },
};

describe("output schema", () => {
  it("defaults context_files_to_preload and rejects a bad type", () => {
    const ok = routerDecisionSchema.parse({
      type: "code-edit",
      complexity: "medium",
      breakpoint: false,
      dispatch_retrieval: false,
      effort: "medium",
    });
    expect(ok.context_files_to_preload).toEqual([]);
    expect(routerDecisionSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
});

describe("stage two ranker", () => {
  it("parses a valid decision and drops out-of-candidate preload files", async () => {
    const decision = {
      type: "code-edit",
      complexity: "medium",
      breakpoint: false,
      dispatch_retrieval: true,
      effort: "medium",
      context_files_to_preload: ["a.ts", "z.ts"],
    };
    const r = await stageTwo(textProvider(JSON.stringify(decision)), { prompt: "p", thought, candidates });
    expect(r.decision.type).toBe("code-edit");
    expect(r.decision.context_files_to_preload).toEqual(["a.ts"]); // z.ts not a candidate
    expect(r.invokedModel).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.0001, 9);
  });

  it("falls back (but counts cost) when the model returns schema-invalid JSON", async () => {
    const r = await stageTwo(textProvider('{"foo":1}'), { prompt: "p", thought, candidates });
    expect(r.invokedModel).toBe(true);
    expect(r.decision.complexity).toBe("medium");
    expect(r.decision.context_files_to_preload).toEqual(["a.ts", "b.ts"]);
  });

  it("falls back with no cost when the provider throws", async () => {
    const r = await stageTwo(throwingProvider, { prompt: "p", thought, candidates });
    expect(r.invokedModel).toBe(false);
    expect(r.costUsd).toBe(0);
    expect(r.decision.type).toBe("other");
  });
});
