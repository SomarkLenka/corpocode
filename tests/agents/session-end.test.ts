import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionEnd } from "../../src/agents/session-end";
import { createSessionStore } from "../../src/agents/sessions";
import { nullLogger } from "../../src/log/ndjson";
import type { HookContext } from "../../src/hooks/context";
import type { AgentBackend } from "../../src/agents/backend";
import type { AgentRegistry } from "../../src/agents/registry";
import type { SessionEndEnvelope } from "../../src/hooks/envelope";

let home = "";
const env = (): NodeJS.ProcessEnv => ({ CORPOCODE_HOME: home });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-sess-end-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const released: string[] = [];
beforeEach(() => {
  released.length = 0;
});

function fakeBackend(): AgentBackend {
  return {
    id: "anthropic-cli",
    invoke: (async () => ({ ok: false })) as unknown as AgentBackend["invoke"], // never called by SessionEnd
    release: async (id) => {
      released.push(id);
    },
    health: async () => ({ up: true }),
    ping: async () => true,
    shutdown: async () => {},
  };
}

function ctx(agents?: AgentRegistry): HookContext {
  return {
    config: { agents: { session_ttl_ms: 3_600_000, max_sessions: 10 } },
    env: env(),
    repoRoot: home, // CORPOCODE_HOME pins state here regardless, but keep it consistent
    logger: nullLogger(),
    agents,
  } as unknown as HookContext;
}

const envelope = (sid: string): SessionEndEnvelope =>
  ({ session_id: sid, transcript_path: "t" }) as SessionEndEnvelope;

describe("handleSessionEnd", () => {
  it("is a no-op when the agent seam is disabled", async () => {
    const res = await handleSessionEnd(envelope("h"), ctx(undefined));
    expect(res).toEqual({});
    expect(released).toEqual([]);
  });

  it("releases this host's agent sessions and removes their records", async () => {
    const registry = { all: () => [fakeBackend()], forTask: () => fakeBackend(), availableFor: () => true } as AgentRegistry;
    const fresh = Date.now(); // the handler evicts with real time, so seed realistic timestamps
    const store = createSessionStore({ ttlMs: 3_600_000, maxSessions: 10, env: env() });
    store.put({ key: "k1", hostSessionId: "h", claudeSessionId: "uuid-1", lastUsedTs: fresh, turns: 1, files: [], persisted: true });
    store.put({ key: "k2", hostSessionId: "other", claudeSessionId: "uuid-2", lastUsedTs: fresh, turns: 1, files: [], persisted: true });

    await handleSessionEnd(envelope("h"), ctx(registry));

    expect(released).toEqual(["uuid-1"]); // only this host's session released
    const remaining = store.all().map((r) => r.key);
    expect(remaining).toContain("k2"); // another host's record is untouched
    expect(remaining).not.toContain("k1"); // this host's record dropped
  });
});
