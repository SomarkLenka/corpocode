// The live trace-recorder path: drive the REAL PostToolUse handler against a REAL temp git repo and
// confirm a write becomes one atomic commit on the trace branch — the verifier→recordWrite→GitManager
// seam end to end. The verifier provider intentionally throws, so the tenet checks degrade to neutral
// (no block) and we isolate the git behavior. This complements manager.test.ts (which tests the
// GitManager directly) by proving the hook actually invokes it.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePostToolUse } from "../../src/verifier/handler";
import type { HookContext } from "../../src/hooks/context";
import type { PostToolUseEnvelope } from "../../src/hooks/envelope";
import { configSchema } from "../../src/config/schema";
import type { Provider } from "../../src/providers/types";
import type { MemoryStore } from "../../src/backends/memory/types";

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

function runGit(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cc-pt-"));
  dirs.push(repo);
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "t@t.test"]);
  runGit(repo, ["config", "user.name", "Test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

// A provider whose every call fails — the verifier checks then degrade to neutral findings, so the
// edit is never blocked and the test observes only the trace-commit behavior.
const failingProvider: Provider = {
  id: "anthropic",
  model: "none",
  modelTier: "fast",
  async chat() {
    throw new Error("no provider in this test");
  },
  async ping() {
    return false;
  },
};

const emptyMemory: MemoryStore = {
  id: "native",
  async recall() {
    return [];
  },
  async capture() {},
  async consolidate() {
    return { captured: 0, superseded: 0 };
  },
  async recordOutcome() {},
  async ping() {
    return true;
  },
};

function contextFor(repo: string, records: Record<string, unknown>[]): HookContext {
  return {
    config: configSchema.parse({}), // git.enabled + commit_per_write default true; verify_on_edit true
    env: {},
    repoRoot: repo,
    project: "p",
    platform: "claude-code",
    logger: { enabled: true, log: (r) => records.push(r as Record<string, unknown>) },
    registry: { forComponent: () => failingProvider, all: () => [failingProvider], availableFor: () => true },
    prompts: { resolve: (id: string) => id },
    graph: {} as unknown as HookContext["graph"],
    context: {} as unknown as HookContext["context"],
    memory: emptyMemory,
    sessionReader: {} as unknown as HookContext["sessionReader"],
    plugins: { plugins: [], templates: [], tenets: [] },
  };
}

describe("PostToolUse → trace branch (live wiring)", () => {
  it("records a written file as one atomic commit on the trace branch", async () => {
    const repo = setupRepo();
    const records: Record<string, unknown>[] = [];
    mkdirSync(join(repo, "src"), { recursive: true });
    const file = join(repo, "src", "feature.ts");
    writeFileSync(file, "export function feature(a: number): number {\n  return a + 1;\n}\n");

    const envelope = {
      session_id: "smoke",
      transcript_path: "/none",
      cwd: repo,
      tool_name: "Write",
      tool_input: { file_path: file },
    } as unknown as PostToolUseEnvelope;

    const res = await handlePostToolUse(envelope, contextFor(repo, records));
    expect(res.continue).not.toBe(false); // neutral findings → not blocked

    // The trace branch now carries exactly the written file as one commit beyond base.
    const log = runGit(repo, ["log", "--format=%H", "corpocode/trace"]).trim().split("\n").filter(Boolean);
    expect(log).toHaveLength(2); // base + the trace commit
    const changed = runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", log[0]!]).trim();
    expect(changed).toBe("src/feature.ts");

    // And the wiring logged the trace commit for observability.
    const gitLog = records.find((r) => r.event === "git" && r.op === "commit");
    expect(gitLog).toMatchObject({ branch: "trace", files: ["src/feature.ts"] });
  });
});
