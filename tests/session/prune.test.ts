import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOldSessions, SESSION_TTL_MS } from "../../src/session/prune";
import { sessionDir, sessionsDir } from "../../src/config/paths";

const NOW = 1_750_000_000_000; // fixed "now" for deterministic age math

describe("pruneOldSessions", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-prune-"));
    env = { CORPOCODE_HOME: home }; // pins all project state (incl. sessions/) into the temp dir
  });

  /** Create a session folder with a file, then backdate its mtime by `ageMs`. */
  function makeSession(id: string, ageMs: number): string {
    const dir = sessionDir(id, undefined, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flow.offset"), "0");
    const t = new Date(NOW - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it("removes session folders older than the TTL and keeps fresh ones", () => {
    const stale = makeSession("old-session", SESSION_TTL_MS + 60_000); // just past 2 days
    const fresh = makeSession("new-session", 60_000); // a minute old

    const removed = pruneOldSessions({ env, now: () => NOW });

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("leaves a folder exactly at the TTL boundary (strictly older is pruned)", () => {
    const boundary = makeSession("boundary", SESSION_TTL_MS); // age == TTL, not strictly greater
    expect(pruneOldSessions({ env, now: () => NOW })).toBe(0);
    expect(existsSync(boundary)).toBe(true);
  });

  it("ignores legacy flat files in the sessions dir (only folders are pruned)", () => {
    const flat = join(sessionsDir(undefined, env), "legacy.json");
    mkdirSync(sessionsDir(undefined, env), { recursive: true });
    writeFileSync(flat, "{}");
    const old = new Date(NOW - SESSION_TTL_MS * 10);
    utimesSync(flat, old, old);

    expect(pruneOldSessions({ env, now: () => NOW })).toBe(0); // flat file is not a session folder
    expect(existsSync(flat)).toBe(true);
  });

  it("returns 0 and never throws when the sessions dir does not exist", () => {
    expect(() => pruneOldSessions({ env, now: () => NOW })).not.toThrow();
    expect(pruneOldSessions({ env, now: () => NOW })).toBe(0);
  });

  it("respects an injected maxAgeMs override", () => {
    const dir = makeSession("s", 10 * 60_000); // 10 minutes old
    expect(pruneOldSessions({ env, now: () => NOW, maxAgeMs: 5 * 60_000 })).toBe(1); // older than 5 min
    expect(existsSync(dir)).toBe(false);
  });
});
