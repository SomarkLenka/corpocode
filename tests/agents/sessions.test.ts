import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionStore,
  sessionKeyForFile,
  sessionKeyForTopic,
  type AgentSessionRecord,
  type SessionStoreOptions,
} from "../../src/agents/sessions";

let home = "";
const env = (): NodeJS.ProcessEnv => ({ CORPOCODE_HOME: home }); // pins all state into the temp dir

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-agent-sess-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const rec = (over: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  key: "k",
  hostSessionId: "h",
  claudeSessionId: "uuid",
  lastUsedTs: 10000,
  turns: 1,
  files: [],
  persisted: true,
  ...over,
});

const store = (opts: Partial<SessionStoreOptions> = {}) =>
  createSessionStore({ ttlMs: 1000, maxSessions: 3, env: env(), now: () => 10000, ...opts });

describe("agent session store", () => {
  it("round-trips a record to disk", () => {
    const s = store();
    s.put(rec({ key: "a" }));
    expect(s.get("a")?.claudeSessionId).toBe("uuid");
    expect(s.get("a")?.hostSessionId).toBe("h");
  });

  it("returns null for an absent key (and an empty dir)", () => {
    expect(store().get("nope")).toBeNull();
    expect(store().all()).toEqual([]);
  });

  it("expires a record older than the TTL and deletes it", () => {
    const s = store({ ttlMs: 1000 });
    s.put(rec({ key: "old", lastUsedTs: 8000 })); // 10000 - 8000 = 2000ms > 1000ms TTL
    expect(s.get("old")).toBeNull();
    expect(s.all().find((r) => r.key === "old")).toBeUndefined(); // removed from disk
  });

  it("evict drops expired records but keeps live ones, reporting the count", () => {
    const s = store({ ttlMs: 1000, maxSessions: 10 });
    s.put(rec({ key: "live", lastUsedTs: 9500 }));
    s.put(rec({ key: "dead", lastUsedTs: 1000 }));
    expect(s.evict().removed).toBe(1);
    expect(s.all().map((r) => r.key)).toEqual(["live"]);
  });

  it("LRU-trims to maxSessions, dropping the least-recently-used", () => {
    const s = store({ ttlMs: 100000, maxSessions: 2 });
    s.put(rec({ key: "a", lastUsedTs: 9000 }));
    s.put(rec({ key: "b", lastUsedTs: 9500 }));
    s.put(rec({ key: "c", lastUsedTs: 9800 }));
    s.evict();
    expect(s.all().map((r) => r.key).sort()).toEqual(["b", "c"]); // "a" (oldest) trimmed
  });

  it("remove deletes a single record", () => {
    const s = store();
    s.put(rec({ key: "x" }));
    s.remove("x");
    expect(s.get("x")).toBeNull();
  });

  it("derives stable, purpose-scoped keys", () => {
    expect(sessionKeyForFile("h", "a.ts")).toBe(sessionKeyForFile("h", "a.ts")); // deterministic
    expect(sessionKeyForFile("h", "a.ts")).not.toBe(sessionKeyForFile("h", "b.ts")); // path-scoped
    expect(sessionKeyForFile("h1", "a.ts")).not.toBe(sessionKeyForFile("h2", "a.ts")); // host-scoped
    expect(sessionKeyForFile("h", "x")).not.toBe(sessionKeyForTopic("h", "x")); // file vs topic distinct
  });
});
