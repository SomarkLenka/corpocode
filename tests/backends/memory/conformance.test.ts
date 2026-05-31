import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeMemoryStore, type NativeMemoryOptions } from "../../../src/backends/memory/native";
import { embedText } from "../../../src/backends/memory/embedder";
import { memoryFile, memoryEmbeddingsFile, ensureDir, memoryDir } from "../../../src/config/paths";
import type { Memory, Scope } from "../../../src/backends/memory/types";

const PROJECT = "test-proj";

describe("native MemoryStore", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let scope: Scope;

  const mk = (over: Partial<NativeMemoryOptions> = {}) =>
    createNativeMemoryStore({ project: PROJECT, env, ...over });

  /** Seed the store file directly — used to set fields capture() doesn't (supersededBy, createdAt). */
  const seed = (records: Memory[]): void => {
    // cwd undefined → CORPOCODE_HOME in env overrides the base (test isolation), matching the store.
    ensureDir(memoryDir(undefined, env));
    writeFileSync(memoryFile(undefined, env), JSON.stringify(records));
    const embeddings: Record<string, number[]> = {};
    for (const m of records) embeddings[m.id] = embedText(m.text);
    writeFileSync(memoryEmbeddingsFile(undefined, env), JSON.stringify(embeddings));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-mem-"));
    env = { CORPOCODE_HOME: home };
    scope = { project: PROJECT, workspaceCascade: false };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("captures then ranks by relevance on recall", async () => {
    const store = mk();
    await store.capture({ kind: "decision", text: "use postgres for primary storage", sessionId: "s1" });
    await store.capture({ kind: "decision", text: "the cat sat quietly on the mat", sessionId: "s1" });
    const results = await store.recall({ query: "database storage postgres", scope, limit: 5 });
    expect(results.length).toBe(2);
    expect(results[0]!.text).toContain("postgres");
  });

  it("scopes recall to a file and kind", async () => {
    const store = mk();
    await store.capture({ kind: "mistake", text: "off by one error", files: ["a.ts"], sessionId: "s" });
    await store.capture({ kind: "mistake", text: "null dereference", files: ["b.ts"], sessionId: "s" });
    await store.capture({ kind: "rule", text: "always validate input", files: ["a.ts"], sessionId: "s" });
    const results = await store.recall({ file: "a.ts", kinds: ["mistake"], scope, limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.files).toContain("a.ts");
    expect(results[0]!.kind).toBe("mistake");
  });

  it("excludes a superseded memory from recall", async () => {
    seed([
      { id: "old", kind: "decision", text: "use mysql database", createdAt: 1000, supersededBy: "new" },
      { id: "new", kind: "decision", text: "use postgres database", createdAt: 2000 },
    ]);
    const results = await mk().recall({ query: "database", scope, limit: 5 });
    expect(results.map((r) => r.id)).toEqual(["new"]);
  });

  it("keeps mistakes through decay while down-ranking a stale decision", async () => {
    const now = 1_000_000_000_000;
    const old = now - 30 * 86_400_000; // 30 days old
    seed([
      { id: "dec", kind: "decision", text: "shared alpha beta gamma", createdAt: old },
      { id: "mis", kind: "mistake", text: "shared alpha beta gamma", createdAt: old },
    ]);
    const store = mk({ now: () => now, halfLifeDays: 1 });
    const results = await store.recall({ query: "shared alpha beta gamma", scope, limit: 5 });
    // Same semantic match; the mistake never decays, the 30-day-old decision does.
    expect(results[0]!.id).toBe("mis");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("appends outcomes via recordOutcome", async () => {
    const store = mk();
    await store.capture({ kind: "approach", text: "incremental migration", sessionId: "s" });
    const [m] = await store.recall({ query: "incremental migration", scope, limit: 1 });
    await store.recordOutcome({ recalledIds: [m!.id], passed: true, sessionId: "s" });
    const [m2] = await store.recall({ query: "incremental migration", scope, limit: 1 });
    expect(m2!.outcomes).toHaveLength(1);
    expect(m2!.outcomes![0]!.passed).toBe(true);
  });

  it("recalls prior-session decisions from a fresh store instance (continuity)", async () => {
    await mk().capture({ kind: "decision", text: "continuity marker alpha", sessionId: "s1" });
    const fresh = mk(); // new instance, same project + home
    const results = await fresh.recall({ query: "continuity marker alpha", scope, limit: 5 });
    expect(results.some((r) => r.text.includes("continuity marker"))).toBe(true);
  });

  it("extracts decision-cue lines on consolidate (Phase 1 minimal)", async () => {
    const store = mk();
    const result = await store.consolidate(
      {
        sessionId: "s",
        messages: [
          { role: "assistant", content: "We decided to use Redis for the cache.\nUnrelated chatter." },
          { role: "user", content: "ok" },
        ],
      },
      scope,
    );
    expect(result.captured).toBe(1);
    expect(result.superseded).toBe(0);
    const results = await store.recall({ query: "redis cache", scope, limit: 5 });
    expect(results.some((r) => /redis/i.test(r.text))).toBe(true);
  });

  it("consolidate supersedes a reversed decision and drops it from recall", async () => {
    seed([{ id: "old", kind: "decision", text: "use mysql for primary storage", createdAt: 1000 }]);
    const store = mk({
      miner: async () => [{ kind: "decision", text: "use postgres for primary storage", reverses: true }],
    });
    const result = await store.consolidate({ sessionId: "s", messages: [] }, scope);
    expect(result.captured).toBe(1);
    expect(result.superseded).toBe(1);
    const recalled = await store.recall({ query: "primary storage", scope, limit: 5 });
    const texts = recalled.map((r) => r.text);
    expect(texts).toContain("use postgres for primary storage");
    expect(texts).not.toContain("use mysql for primary storage"); // the superseded one is invisible
  });

  it("does not supersede an unrelated new decision", async () => {
    seed([{ id: "old", kind: "decision", text: "use postgres for primary storage", createdAt: 1000 }]);
    const store = mk({ miner: async () => [{ kind: "decision", text: "adopt tailwind for styling" }] });
    const result = await store.consolidate({ sessionId: "s", messages: [] }, scope);
    expect(result.superseded).toBe(0);
    expect((await store.recall({ query: "storage", scope, limit: 5 })).length).toBe(2);
  });

  it("returns empty recall (no throw) on a corrupt store", async () => {
    ensureDir(memoryDir(undefined, env));
    writeFileSync(memoryFile(undefined, env), "{ this is not valid json");
    const results = await mk().recall({ query: "anything", scope, limit: 5 });
    expect(results).toEqual([]);
  });

  it("routes embedding through the configured embedder", async () => {
    let calls = 0;
    const embedder = {
      id: "spy",
      embed: async (t: string) => {
        calls++;
        return embedText(t);
      },
    };
    const store = mk({ embedder });
    await store.capture({ kind: "decision", text: "alpha", sessionId: "s" });
    await store.recall({ query: "alpha", scope, limit: 1 });
    expect(calls).toBeGreaterThan(0);
  });
});
