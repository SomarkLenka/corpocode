// The PreToolUse heavy-coding router: fires only on a write-class tool when the cached decision is a
// medium/hard code-edit/code-gen phase, recommends an agent with context, and rate-limits to once per
// phase. Non-coding moments and non-write tools inject nothing.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRouteHeavyCoding } from "../../src/toolbox/route";
import { writeCatalog } from "../../src/toolbox/catalog";
import { catalogFile } from "../../src/config/paths";
import { writeLastDecision, type CachedDecision } from "../../src/session/decision-cache";
import { configSchema } from "../../src/config/schema";
import type { HookContext } from "../../src/hooks/context";
import type { PreToolUseEnvelope } from "../../src/hooks/envelope";
import type { Provider, ChatInput, ChatOutput } from "../../src/providers/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const provider: Provider = {
  id: "anthropic",
  model: "fake",
  modelTier: "fast",
  async chat(_input: ChatInput): Promise<ChatOutput> {
    return { text: JSON.stringify({ selected: [{ name: "implementer", reason: "writes code" }] }), inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, providerId: "anthropic", model: "fake", finishReason: "stop" };
  },
  async ping() {
    return true;
  },
};

function ctxFor(env: NodeJS.ProcessEnv, records: Record<string, unknown>[]): HookContext {
  return {
    config: configSchema.parse({}),
    env,
    repoRoot: "/repo",
    project: "p",
    platform: "claude-code",
    logger: { enabled: true, log: (r: unknown) => records.push(r as Record<string, unknown>) },
    registry: { forComponent: () => provider, all: () => [provider] },
    sessionReader: { lineOfThought: async () => ({ intent: "refactor the retry path", openQuestions: [], recentDecisions: [], entities: ["retry"] }), filePurpose: async () => null, retrievalCues: async () => ({ query: "", files: [] }) },
    graph: {} as unknown as HookContext["graph"],
    context: {} as unknown as HookContext["context"],
    memory: {} as unknown as HookContext["memory"],
    plugins: { plugins: [], templates: [], tenets: [] },
  } as unknown as HookContext;
}

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "cc-route-"));
  dirs.push(d);
  return { CORPOCODE_HOME: d } as NodeJS.ProcessEnv;
}

const write = (file = "/repo/src/a.ts"): PreToolUseEnvelope =>
  ({ session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name: "Write", tool_input: { file_path: file } }) as unknown as PreToolUseEnvelope;

const heavyDecision: CachedDecision = { type: "code-edit", complexity: "medium", breakpoint: false, dispatch_retrieval: false, effort: "medium", recalledIds: [], ts: 1 };

describe("maybeRouteHeavyCoding", () => {
  it("recommends an agent with context on a write during a heavy coding phase, once per phase", async () => {
    const env = home();
    writeCatalog(catalogFile(env), { entries: [{ kind: "agent", name: "implementer", scope: "user", absPath: "/x", description: "writes production code" }] });
    writeLastDecision("s", heavyDecision, "/repo", env);

    const ctx = ctxFor(env, []);
    const block = await maybeRouteHeavyCoding(write(), ctx);
    expect(block).toContain("implementer");
    expect(block).toContain("Context to hand the agent");

    // Rate-limited: the second write in the same phase injects nothing.
    expect(await maybeRouteHeavyCoding(write(), ctx)).toBeNull();
  });

  it("does not fire on a non-coding moment", async () => {
    const env = home();
    writeCatalog(catalogFile(env), { entries: [{ kind: "agent", name: "implementer", scope: "user", absPath: "/x", description: "writes code" }] });
    writeLastDecision("s", { ...heavyDecision, type: "exploration" }, "/repo", env);
    expect(await maybeRouteHeavyCoding(write(), ctxFor(env, []))).toBeNull();
  });

  it("does not fire on a non-write tool", async () => {
    const env = home();
    writeLastDecision("s", heavyDecision, "/repo", env);
    const webfetch = { session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name: "WebFetch", tool_input: {} } as unknown as PreToolUseEnvelope;
    expect(await maybeRouteHeavyCoding(webfetch, ctxFor(env, []))).toBeNull();
  });
});
