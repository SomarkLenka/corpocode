import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectFileRead } from "../../src/filter/inject";
import { writeLastDecision } from "../../src/session/decision-cache";
import { defaultConfig } from "../../src/config/load";
import type { HookContext } from "../../src/hooks/context";
import type { PreToolUseEnvelope } from "../../src/hooks/envelope";
import type { ChatOutput, Provider } from "../../src/providers/types";
import type { ScoredMemory } from "../../src/backends/memory/types";

const SESSION = "sess-1";

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

interface CtxOver {
  env: NodeJS.ProcessEnv;
  purpose?: string | null;
  warnings?: ScoredMemory[];
  relevance?: string;
}

function makeCtx(over: CtxOver): HookContext {
  return {
    config: defaultConfig(),
    project: "proj",
    env: over.env,
    logger: { enabled: false, log: () => {} },
    registry: { forComponent: () => provider(over.relevance ?? "{}"), all: () => [] },
    memory: {
      id: "native",
      recall: async () => over.warnings ?? [],
      capture: async () => {},
      consolidate: async () => ({ captured: 0, superseded: 0 }),
      recordOutcome: async () => {},
      ping: async () => true,
    },
    sessionReader: {
      lineOfThought: async () => ({ intent: "", openQuestions: [], recentDecisions: [], entities: [] }),
      filePurpose: async () => (over.purpose === undefined ? "fix the totals" : over.purpose),
      retrievalCues: async () => ({ query: "", files: [] }),
    },
    graph: {
      getNode: async (name: string) => ({ id: `n_${name}`, name, kind: "file" as const, path: `src/${name}` }),
      getNeighbors: async () => ({
        center: { id: "c", name: "c", kind: "file" as const },
        nodes: [{ id: "x", name: "helper", kind: "function" as const }],
        edges: [],
        depth: 1,
      }),
    },
  } as unknown as HookContext;
}

const readEnv = (file: string): PreToolUseEnvelope =>
  ({ session_id: SESSION, transcript_path: "/t", tool_name: "Read", tool_input: { file_path: file } }) as unknown as PreToolUseEnvelope;

describe("context injector", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-inj-"));
    env = { CORPOCODE_HOME: home };
    file = join(home, "totals.ts");
    writeFileSync(file, "export function computeTotal() { return 1 + 2; }\nexport function unrelated() {}");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("carries an obvious purpose onto a focused slice", async () => {
    const ctx = makeCtx({ env, relevance: JSON.stringify({ relevant: true, confidence: 0.9, focus: "computeTotal()" }) });
    const res = await injectFileRead(readEnv(file), ctx);
    expect(res.additionalContext).toContain("Focus on: computeTotal()");
    expect(res.additionalContext).toContain("fix the totals");
  });

  it("surfaces a recorded mistake about the file before the edit", async () => {
    const warnings: ScoredMemory[] = [
      { id: "w1", kind: "mistake", text: "off-by-one in the pager", createdAt: 1, score: 0.9 },
    ];
    const ctx = makeCtx({ env, warnings, relevance: JSON.stringify({ relevant: false, confidence: 0.1, focus: "" }) });
    const res = await injectFileRead(readEnv(file), ctx);
    expect(res.additionalContext).toContain("[mistake] off-by-one in the pager");
  });

  it("falls back to the full read when the relevance pass is low-confidence", async () => {
    const ctx = makeCtx({ env, relevance: JSON.stringify({ relevant: true, confidence: 0.3, focus: "computeTotal()" }) });
    const res = await injectFileRead(readEnv(file), ctx);
    expect(res).toEqual({}); // nothing injected — the full read proceeds
  });

  it("asks a clarifying question when the purpose is unknown", async () => {
    const ctx = makeCtx({ env, purpose: null });
    const res = await injectFileRead(readEnv(file), ctx);
    expect(res.additionalContext).toContain("isn't clear");
  });

  it("never slices during an exploration moment (whole file)", async () => {
    writeLastDecision(
      SESSION,
      { type: "exploration", complexity: "medium", breakpoint: false, dispatch_retrieval: false, effort: "medium", recalledIds: [], ts: 1 },
      env,
    );
    const ctx = makeCtx({ env, relevance: JSON.stringify({ relevant: true, confidence: 0.95, focus: "computeTotal()" }) });
    const res = await injectFileRead(readEnv(file), ctx);
    expect(res.additionalContext ?? "").not.toContain("Focus on:"); // exploration → no slice
  });
});
