// Conformance for the OpenViking adapter, run against an in-memory fake daemon injected as
// `fetchFn`. It exercises the adapter's data path (find/load/write/tree/grep), tier escalation,
// health, and — the resilience contract that matters most — exactly-one-restart on a refused
// connection. The same logic must behave identically when the planned native ContextStore swaps in.
import { describe, it, expect } from "vitest";
import {
  createOpenVikingAdapter,
  type OpenVikingAdapterOptions,
} from "../../../src/backends/context/openviking-adapter";

interface Stored {
  content: string;
  kind: string;
}

/** A tiny in-memory OpenViking daemon. `up` gates connectivity to test the restart path. */
function makeFakeDaemon(initiallyUp = true) {
  const store = new Map<string, Stored>();
  const state = { up: initiallyUp, requests: 0 };

  const refuse = (): never => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:1933") as Error & { code: string };
    err.code = "ECONNREFUSED";
    throw err;
  };

  // L0 ≈ abstract, L1 ≈ overview, L2 = full — derived from the full stored content so tokens grow.
  const tier = (full: string, t: string): string => {
    if (t === "L0") return full.split("\n")[0]!.slice(0, 40);
    if (t === "L1") return full.slice(0, Math.ceil(full.length / 2));
    return full;
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = (async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
    state.requests++;
    if (!state.up) refuse();
    const url = new URL(typeof rawUrl === "string" ? rawUrl : rawUrl.toString());
    const path = url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path === "/health") return json({ version: "test-1.0" });

    if (path === "/find") {
      const resources = [...store.entries()].map(([uri, s]) => ({
        uri,
        kind: s.kind,
        tier: "L0",
        content: tier(s.content, "L0"),
        score: 0.9,
      }));
      return json({ resources, trajectory: ["root", "match"] });
    }

    if (path === "/load") {
      const uri = url.searchParams.get("uri")!;
      const t = url.searchParams.get("tier") ?? "L2";
      const s = store.get(uri);
      if (!s) return json({ content: "" }, 404);
      return json({ content: tier(s.content, t) });
    }

    if (path === "/resource") {
      store.set(String(body.uri), { content: String(body.content), kind: String(body.kind ?? "memory") });
      return json({ ok: true });
    }

    if (path === "/tree") {
      const prefix = url.searchParams.get("uri") ?? "";
      const entries = [...store.entries()]
        .filter(([uri]) => uri.startsWith(prefix))
        .map(([uri, s]) => ({ uri, kind: s.kind, abstract: tier(s.content, "L0"), childCount: 0 }));
      return json({ entries });
    }

    if (path === "/grep") {
      const pattern = url.searchParams.get("pattern") ?? "";
      const resources = [...store.entries()]
        .filter(([, s]) => s.content.includes(pattern))
        .map(([uri, s]) => ({ uri, kind: s.kind, tier: "L2", content: s.content }));
      return json({ resources });
    }

    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;

  return { fetchFn, state, store };
}

function adapter(over: Partial<OpenVikingAdapterOptions> & { daemon: ReturnType<typeof makeFakeDaemon> }) {
  return createOpenVikingAdapter({
    fetchFn: over.daemon.fetchFn,
    sleep: async () => {}, // instant polling in tests
    pollIntervalMs: 1,
    startTimeoutMs: 50,
    ...over,
  });
}

describe("OpenViking adapter conformance", () => {
  it("write then find round-trips a resource at L0", async () => {
    const daemon = makeFakeDaemon();
    const store = adapter({ daemon });
    await store.write("viking://agent/memories/s1/1.md", "decided to use postgres\nmore detail here", {
      kind: "memory",
    });
    const found = await store.find("postgres", { tier: "L0", limit: 5 });
    expect(found.tier).toBe("L0");
    expect(found.resources).toHaveLength(1);
    expect(found.resources[0]!.uri).toBe("viking://agent/memories/s1/1.md");
    expect(found.trajectory).toEqual(["root", "match"]);
  });

  it("load escalates a resource across tiers with monotonically larger content", async () => {
    const daemon = makeFakeDaemon();
    const store = adapter({ daemon });
    const uri = "viking://resource/doc.md";
    const full = "line one is the abstract\n" + "x".repeat(500);
    await store.write(uri, full);
    const l0 = await store.load(uri, "L0");
    const l1 = await store.load(uri, "L1");
    const l2 = await store.load(uri, "L2");
    expect(l0.length).toBeLessThan(l1.length);
    expect(l1.length).toBeLessThan(l2.length);
    expect(l2).toBe(full);
  });

  it("tree lists a namespace with abstracts and without full bodies", async () => {
    const daemon = makeFakeDaemon();
    const store = adapter({ daemon });
    await store.write("viking://agent/memories/s1/1.md", "abstract one\nbody body body");
    await store.write("viking://agent/memories/s1/2.md", "abstract two\nbody body body");
    const entries = await store.tree("viking://agent/memories/s1", { depth: 1 });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.abstract).toBeTruthy();
    expect(entries[0]!.abstract!.length).toBeLessThan(40);
  });

  it("grep finds a known substring", async () => {
    const daemon = makeFakeDaemon();
    const store = adapter({ daemon });
    await store.write("viking://resource/a.md", "the quick brown fox");
    await store.write("viking://resource/b.md", "lazy dog sleeps");
    const hits = await store.grep("quick brown");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.uri).toBe("viking://resource/a.md");
  });

  it("health and ping reflect the daemon's real state", async () => {
    expect(await adapter({ daemon: makeFakeDaemon(true) }).ping()).toBe(true);
    const downStore = adapter({ daemon: makeFakeDaemon(false) });
    expect(await downStore.ping()).toBe(false);
    expect((await downStore.health()).up).toBe(false);
  });

  it("makes exactly one restart attempt on a refused connection, then succeeds", async () => {
    const daemon = makeFakeDaemon(false); // daemon down
    let spawns = 0;
    const store = adapter({
      daemon,
      spawnServer: () => {
        spawns++;
        daemon.state.up = true; // the restart brings it up
      },
    });
    await store.write("viking://agent/memories/s/1.md", "digest");
    expect(spawns).toBe(1); // exactly one restart attempt
    const found = await store.find("digest", { tier: "L0", limit: 5 });
    expect(found.resources).toHaveLength(1);
  });

  it("fails fast and cleanly when the server binary is missing (no unhandled crash)", async () => {
    // Uses the REAL default spawner against a guaranteed-missing binary: its ChildProcess emits an
    // async 'error' (ENOENT). Without the error handler this would crash the whole process (an
    // unhandled 'error' event is fatal), taking the test runner down. A clean rejection proves the fix.
    const refuse = (async () => {
      const err = new Error("connect ECONNREFUSED") as Error & { code: string };
      err.code = "ECONNREFUSED";
      throw err;
    }) as unknown as typeof fetch;
    const store = createOpenVikingAdapter({
      serverCmd: "corpocode-definitely-not-a-real-binary-xyz",
      fetchFn: refuse,
      pollIntervalMs: 5,
      startTimeoutMs: 3000,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });
    await expect(store.write("viking://x", "y")).rejects.toThrow(/could not be started|did not become healthy/);
  });

  it("raises a clean error when the daemon stays down after a restart attempt", async () => {
    const daemon = makeFakeDaemon(false);
    let spawns = 0;
    const store = adapter({
      daemon,
      spawnServer: () => {
        spawns++; // restart attempted but daemon never comes up
      },
      startTimeoutMs: 5,
    });
    await expect(store.write("viking://x", "y")).rejects.toThrow(/OpenViking did not become healthy/);
    expect(spawns).toBe(1);
  });
});
