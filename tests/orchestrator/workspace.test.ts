import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../../src/orchestrator/workspace";
import type { CommandRunner } from "../../src/install/run";

type Rule = { match: (args: string[]) => boolean; code?: number; stdout?: string };

function fakeRunner(rules: Rule[] = []) {
  const calls: string[][] = [];
  let gate: Promise<void> | null = null;
  const run: CommandRunner = async (_cmd, args) => {
    calls.push(args);
    if (gate) await gate;
    const rule = rules.find((r) => r.match(args));
    return { code: rule?.code ?? 0, stdout: rule?.stdout ?? "", stderr: "" };
  };
  return { run, calls, setGate: (p: Promise<void>) => (gate = p) };
}

describe("createWorkspace", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cc-ws-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("ensureIntegration creates the branch from baseRef when missing", async () => {
    const { run, calls } = fakeRunner([{ match: (a) => a[0] === "rev-parse", code: 1 }]);
    const ws = createWorkspace({ runId: "run-1", repoRoot: repo, run, baseRef: "main", cwd: repo });
    const branch = await ws.ensureIntegration();
    expect(branch).toBe("corpocode/run-1/integration");
    expect(calls).toContainEqual(["branch", "corpocode/run-1/integration", "main"]);
  });

  it("create adds a worktree on an attempt branch rooted at the integration branch", async () => {
    const { run, calls } = fakeRunner();
    const ws = createWorkspace({ runId: "run-1", repoRoot: repo, run, cwd: repo });
    const handle = await ws.create("t1", 1);
    expect(handle.branch).toBe("corpocode/run-1/t1/a1");
    expect(handle.path).toContain(join("run-1", "worktrees", "t1-a1"));
    const add = calls.find((a) => a[0] === "worktree" && a[1] === "add");
    expect(add).toBeDefined();
    expect(add).toContain("corpocode/run-1/integration"); // rooted at integration, never the user's branch
  });

  it("serializes concurrent worktree creation (git config-lock contention)", async () => {
    const { run, calls, setGate } = fakeRunner();
    let release!: () => void;
    setGate(new Promise<void>((r) => (release = r)));
    const ws = createWorkspace({ runId: "run-1", repoRoot: repo, run, cwd: repo });
    const first = ws.create("t1", 1);
    const second = ws.create("t2", 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((a) => a[0] === "worktree").length).toBe(1); // second waits for first
    release();
    await Promise.all([first, second]);
    expect(calls.filter((a) => a[0] === "worktree").length).toBe(2);
  });

  it("copies .worktreeinclude-listed files into a fresh worktree", async () => {
    writeFileSync(join(repo, ".worktreeinclude"), "# gitignored-but-needed\n.env\nmissing.txt\n");
    writeFileSync(join(repo, ".env"), "SECRET=1");
    const { run } = fakeRunner();
    const ws = createWorkspace({ runId: "run-1", repoRoot: repo, run, cwd: repo });
    const handle = await ws.create("t1", 1);
    expect(readFileSync(join(handle.path, ".env"), "utf8")).toBe("SECRET=1");
    expect(existsSync(join(handle.path, "missing.txt"))).toBe(false); // absent sources skipped, no throw
  });

  it("removeIfClean removes clean worktrees and keeps dirty ones", async () => {
    const dirty = fakeRunner([{ match: (a) => a[0] === "status", stdout: " M src/x.ts\n" }]);
    const wsDirty = createWorkspace({ runId: "run-1", repoRoot: repo, run: dirty.run, cwd: repo });
    expect(await wsDirty.removeIfClean("/wt/t1-a1")).toBe("kept-dirty");
    expect(dirty.calls.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(false);

    const clean = fakeRunner([{ match: (a) => a[0] === "status", stdout: "" }]);
    const wsClean = createWorkspace({ runId: "run-1", repoRoot: repo, run: clean.run, cwd: repo });
    expect(await wsClean.removeIfClean("/wt/t1-a1")).toBe("removed");
    expect(clean.calls.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });
});
