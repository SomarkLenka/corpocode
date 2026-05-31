import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStop } from "../../src/compactor/worker";
import { memdirSessionSummariesDir } from "../../src/compactor/memdir";
import { defaultConfig } from "../../src/config/load";
import type { HookContext } from "../../src/hooks/context";
import type { StopEnvelope } from "../../src/hooks/envelope";
import type { CorpoConfig } from "../../src/config/schema";
import type { ChatInput, ChatOutput, Provider } from "../../src/providers/types";
import type { ContextStore } from "../../src/backends/context/types";

const SESSION = "comp-sess";

const TRANSCRIPT_LINES = [
  { role: "user", content: "ancient question about caching" },
  { role: "assistant", content: "we chose redis for the cache" },
  { role: "tool", content: "tool output blob" },
  { role: "user", content: "current question" },
  { role: "assistant", content: "current answer" },
].map((l) => JSON.stringify(l));

interface Spies {
  digestInput?: ChatInput;
  writes: Array<{ uri: string; content: string }>;
  consolidated: boolean;
  recordedOutcome: boolean;
}

function makeCtx(opts: {
  env: NodeJS.ProcessEnv;
  spies: Spies;
  contextWrite?: (uri: string, content: string) => Promise<void>;
  backend?: "openviking" | "memdir";
}): HookContext {
  const provider: Provider = {
    id: "ollama",
    model: "m",
    modelTier: "fast",
    chat: async (input: ChatInput): Promise<ChatOutput> => {
      opts.spies.digestInput = input;
      return {
        text: "DIGEST: chose redis",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        providerId: "ollama",
        model: "m",
        finishReason: "stop",
      };
    },
    ping: async () => true,
  };
  const config: CorpoConfig = defaultConfig();
  config.sliding_window = { preserved_turns: 1, preserved_tool_outputs: 1 };
  if (opts.backend) config.compaction = { backend: opts.backend };

  const context = {
    id: "openviking",
    write: async (uri: string, content: string) => {
      if (opts.contextWrite) return opts.contextWrite(uri, content);
      opts.spies.writes.push({ uri, content });
    },
  } as unknown as ContextStore;

  return {
    config,
    project: "proj",
    env: opts.env,
    logger: { enabled: false, log: () => {} },
    registry: { forComponent: () => provider, all: () => [provider] },
    context,
    memory: {
      id: "native",
      recall: async () => [],
      capture: async () => {},
      consolidate: async () => {
        opts.spies.consolidated = true;
        return { captured: 1, superseded: 0 };
      },
      recordOutcome: async () => {
        opts.spies.recordedOutcome = true;
      },
      ping: async () => true,
    },
  } as unknown as HookContext;
}

describe("compactor worker (Stop)", () => {
  let home: string;
  let transcriptPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-comp-"));
    env = { CORPOCODE_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude") };
    transcriptPath = join(home, "transcript.jsonl");
    writeFileSync(transcriptPath, TRANSCRIPT_LINES.join("\n"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const stopEnv = (): StopEnvelope =>
    ({ session_id: SESSION, transcript_path: transcriptPath }) as unknown as StopEnvelope;

  it("writes the digest to OpenViking and consolidates, never compacting the preserved turns", async () => {
    const spies: Spies = { writes: [], consolidated: false, recordedOutcome: false };
    const res = await handleStop(stopEnv(), makeCtx({ env, spies }));
    expect(res).toEqual({});
    expect(spies.writes).toHaveLength(1);
    expect(spies.writes[0]!.uri).toContain(`viking://agent/memories/${SESSION}/`);
    expect(spies.consolidated).toBe(true);
    // The digest saw only the compactable (older) slice, never the preserved recent turns.
    const sent = spies.digestInput!.messages[0]!.content;
    expect(sent).toContain("ancient question");
    expect(sent).not.toContain("current question");
  });

  it("falls back to memdir when the daemon write fails — no error reaches the session", async () => {
    const spies: Spies = { writes: [], consolidated: false, recordedOutcome: false };
    const ctx = makeCtx({
      env,
      spies,
      contextWrite: async () => {
        throw new Error("OpenViking did not become healthy"); // daemon still down after its one restart
      },
    });
    const res = await handleStop(stopEnv(), ctx);
    expect(res).toEqual({}); // never an error to the session
    const dir = memdirSessionSummariesDir(env);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith(SESSION))).toBe(true);
  });

  it("uses memdir as the primary backend when configured, skipping the daemon", async () => {
    const spies: Spies = { writes: [], consolidated: false, recordedOutcome: false };
    const ctx = makeCtx({ env, spies, backend: "memdir" });
    await handleStop(stopEnv(), ctx);
    expect(spies.writes).toHaveLength(0); // daemon never touched
    expect(readdirSync(memdirSessionSummariesDir(env)).length).toBeGreaterThan(0);
  });
});
