// Native ContextStore conformance (Phase 5). Asserts the SAME round-trip behaviors the OpenViking
// adapter suite asserts — write→find at L0, tier escalation with monotonically larger content, tree with
// abstracts and no bodies, grep substring, health — over the in-process store. The daemon-specific tests
// (restart-on-refused, missing-binary) have no native counterpart: an in-process library cannot be down,
// which is precisely the resilience win, so `start`/`health` are trivially healthy.
import { describe, it, expect } from "vitest";
import { createNativeContextStore, type ContextStorage } from "../../../src/backends/context/native";

function memStorage(): ContextStorage {
  let all: Record<string, unknown> = {};
  return {
    read: () => all as never,
    write: (next) => {
      all = next as never;
    },
  };
}

const store = () => createNativeContextStore({ storage: memStorage() });

describe("native context store conformance", () => {
  it("write then find round-trips a resource at L0", async () => {
    const s = store();
    await s.write("viking://agent/memories/s1/1.md", "decided to use postgres\nmore detail here", { kind: "memory" });
    const found = await s.find("postgres", { tier: "L0", limit: 5 });
    expect(found.tier).toBe("L0");
    expect(found.resources).toHaveLength(1);
    expect(found.resources[0]!.uri).toBe("viking://agent/memories/s1/1.md");
    expect(found.trajectory).toBeDefined();
  });

  it("load escalates a resource across tiers with monotonically larger content", async () => {
    const s = store();
    const uri = "viking://resource/doc.md";
    const full = "line one is the abstract\n" + "x".repeat(500);
    await s.write(uri, full);
    const l0 = await s.load(uri, "L0");
    const l1 = await s.load(uri, "L1");
    const l2 = await s.load(uri, "L2");
    expect(l0.length).toBeLessThan(l1.length);
    expect(l1.length).toBeLessThan(l2.length);
    expect(l2).toBe(full);
  });

  it("tree lists a namespace with abstracts and without full bodies", async () => {
    const s = store();
    await s.write("viking://agent/memories/s1/1.md", "abstract one\nbody body body");
    await s.write("viking://agent/memories/s1/2.md", "abstract two\nbody body body");
    const entries = await s.tree("viking://agent/memories/s1", { depth: 1 });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.abstract).toBeTruthy();
    expect(entries[0]!.abstract!.length).toBeLessThanOrEqual(40);
  });

  it("grep finds a known substring backed by full text", async () => {
    const s = store();
    await s.write("viking://resource/a.md", "the quick brown fox");
    await s.write("viking://resource/b.md", "lazy dog sleeps");
    const hits = await s.grep("quick brown");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.uri).toBe("viking://resource/a.md");
  });

  it("health and ping are up for an in-process store, and start does not throw", async () => {
    const s = store();
    expect(await s.ping()).toBe(true);
    expect((await s.health()).up).toBe(true);
    await expect(s.start()).resolves.toBeUndefined();
  });

  it("find ranks the more semantically similar resource first", async () => {
    const s = store();
    await s.write("viking://r/postgres.md", "we chose postgres as the primary database");
    await s.write("viking://r/redis.md", "redis handles the cache layer");
    const found = await s.find("postgres database choice", { tier: "L0", limit: 2 });
    expect(found.resources[0]!.uri).toBe("viking://r/postgres.md");
  });
});
