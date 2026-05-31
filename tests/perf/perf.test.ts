// Performance layer (Phase 4 §4): a version-scoped cache that never serves a stale result, a global
// concurrency limiter that bounds in-flight work, the graph-score memoization wired on top of the
// cache, and the latency percentiles the stats view reports.
import { describe, it, expect } from "vitest";
import { createCache, memoryStore } from "../../src/perf/cache";
import { createLimiter } from "../../src/perf/limiter";
import { withScoreFilesCache } from "../../src/perf/graph-cache";
import { computeStats } from "../../src/commands/stats";
import type { KnowledgeGraph, ScoredFile } from "../../src/backends/graph/types";

describe("version-scoped cache", () => {
  it("returns a hit without recomputing, and a version bump invalidates (never stale)", () => {
    const store = memoryStore();
    const c1 = createCache<number>({ version: "v1", store });
    c1.set("k", 1);
    expect(createCache<number>({ version: "v1", store }).get("k")).toBe(1); // same version → hit survives

    // A new version drops everything — a hit can never be against an old version.
    const c2 = createCache<number>({ version: "v2", store });
    expect(c2.get("k")).toBeUndefined();
  });
});

describe("global concurrency limiter", () => {
  it("never lets more than `max` tasks run at once", async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("graph score memoization", () => {
  it("calls the underlying graph once per key within a version, and re-runs after a version change", async () => {
    let calls = 0;
    const graph: KnowledgeGraph = {
      id: "fake",
      async scoreFiles(prompt: string): Promise<ScoredFile[]> {
        calls++;
        return [{ path: `${prompt}.ts`, score: 1, nodeId: "n" }];
      },
      async getNode() {
        return null;
      },
      async getNeighbors() {
        return { center: { id: "c", name: "c", kind: "file" }, nodes: [], edges: [], depth: 1 };
      },
      async findPath() {
        return null;
      },
      async query() {
        return { nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false };
      },
      async ensureBuilt() {},
      async refresh() {},
      async ping() {
        return true;
      },
    };

    const v1 = createCache<ScoredFile[]>({ version: "v1", store: memoryStore() });
    const cached = withScoreFilesCache(graph, { repoRoot: "/x", cache: v1 });
    await cached.scoreFiles("a", { limit: 5 });
    await cached.scoreFiles("a", { limit: 5 }); // served from cache
    expect(calls).toBe(1);
    await cached.scoreFiles("b", { limit: 5 }); // different key → underlying call
    expect(calls).toBe(2);

    // A fresh cache (as a new graph version would produce) re-runs even the same key — never stale.
    const v2 = createCache<ScoredFile[]>({ version: "v2", store: memoryStore() });
    const cached2 = withScoreFilesCache(graph, { repoRoot: "/x", cache: v2 });
    await cached2.scoreFiles("a", { limit: 5 });
    expect(calls).toBe(3);
  });
});

describe("stats latency percentiles", () => {
  it("computes p50/p90/p99 from logged latencies", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ ts: "2026-05-30T00:00:00.000Z", event: "router", latency_ms: i + 1 }),
    );
    const report = computeStats(lines);
    expect(report.latencyMs.p50).toBeGreaterThan(0);
    expect(report.latencyMs.p90).toBeGreaterThan(report.latencyMs.p50);
    expect(report.latencyMs.p99).toBeGreaterThanOrEqual(report.latencyMs.p90);
  });
});
