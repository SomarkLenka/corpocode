// SessionStart handler: deterministically gates the user's skills/agents (no LLM), logs a summary, and
// returns {}. Disabling gate_on_session_start makes it a no-op.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionStart } from "../../src/toolbox/session-start";
import { parseToolboxFrontmatter } from "../../src/toolbox/frontmatter";
import { configSchema } from "../../src/config/schema";
import type { HookContext } from "../../src/hooks/context";
import type { SessionStartEnvelope } from "../../src/hooks/envelope";

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

function setup(): { claudeHome: string; env: NodeJS.ProcessEnv; agent: string } {
  const claudeHome = mkdtempSync(join(tmpdir(), "cc-ss-claude-"));
  const corpo = mkdtempSync(join(tmpdir(), "cc-ss-corpo-"));
  dirs.push(claudeHome, corpo);
  mkdirSync(join(claudeHome, "agents"), { recursive: true });
  const agent = join(claudeHome, "agents", "foo.md");
  writeFileSync(agent, "---\nname: foo\ndescription: Use foo when doing X.\n---\nbody\n");
  return { claudeHome, env: { CLAUDE_CONFIG_DIR: claudeHome, CORPOCODE_HOME: corpo } as NodeJS.ProcessEnv, agent };
}

function ctxFor(env: NodeJS.ProcessEnv, records: Record<string, unknown>[], config = configSchema.parse({})): HookContext {
  return {
    config,
    env,
    repoRoot: "/repo",
    logger: { enabled: true, log: (r: unknown) => records.push(r as Record<string, unknown>) },
  } as unknown as HookContext;
}

const envelope = { session_id: "s", transcript_path: "/t", cwd: "/repo" } as unknown as SessionStartEnvelope;

describe("handleSessionStart", () => {
  it("gates the user's skills/agents and logs a toolbox summary, returning {}", async () => {
    const { env, agent } = setup();
    const records: Record<string, unknown>[] = [];
    const res = await handleSessionStart(envelope, ctxFor(env, records));
    expect(res).toEqual({});
    expect(parseToolboxFrontmatter(readFileSync(agent, "utf8")).gated).toBe(true);
    const log = records.find((r) => r.event === "toolbox" && r.trigger === "sessionstart");
    expect(log).toMatchObject({ gated: 1 });
  });

  it("is a no-op when gate_on_session_start is off", async () => {
    const { env, agent } = setup();
    const config = configSchema.parse({ toolbox: { gate_on_session_start: false } });
    await handleSessionStart(envelope, ctxFor(env, [], config));
    expect(parseToolboxFrontmatter(readFileSync(agent, "utf8")).gated).toBe(false);
  });
});
