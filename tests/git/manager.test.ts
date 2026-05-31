// Git two-branch model — integration test against a REAL temporary git repo, driven through the
// public GitManager exactly as the hooks drive it. Setup and inspection use raw git (execFileSync);
// only the operations under test go through the manager → plumbing's guarded `git()`. Each test maps
// to a clause of the Phase 3 §2 Definition of Done (master spec §15.13).
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createGitManager } from "../../src/git/manager";
import { git } from "../../src/git/plumbing";
import type { CommandRunner } from "../../src/install/run";

const TRACE = "corpocode/trace";
const CLEAN = "corpocode/clean";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort; the OS temp dir is reclaimed regardless
    }
  }
});

/** Raw git for test setup/inspection — deliberately NOT the guarded manager path. */
function runGit(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** A fresh repo with one base commit and a configured identity (commit-tree needs one). */
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cc-git-"));
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

function write(repo: string, rel: string, body: string): string {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

const shas = (repo: string, branch: string): string[] =>
  runGit(repo, ["log", "--format=%H", branch]).trim().split("\n").filter(Boolean);

const filesOf = (repo: string, sha: string): string[] =>
  runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).trim().split("\n").filter(Boolean).sort();

function manager(repo: string) {
  return createGitManager({ repoRoot: repo, traceBranch: TRACE, cleanBranch: CLEAN });
}

describe("GitManager — trace branch (the flight recorder)", () => {
  it("records three writes as three atomic single-file commits, and the middle reverts cleanly on its own", async () => {
    const repo = setupRepo();
    const mgr = manager(repo);

    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      write(repo, name, `content ${name}\n`);
      await mgr.commitWrite(join(repo, name), { sessionId: "s1", mode: "suggest" });
    }

    const log = shas(repo, TRACE);
    expect(log).toHaveLength(4); // base + three writes
    const [cCommit, bCommit, aCommit] = log; // newest first

    // Atomic: every trace commit touches exactly one file.
    expect(filesOf(repo, aCommit!)).toEqual(["a.txt"]);
    expect(filesOf(repo, bCommit!)).toEqual(["b.txt"]);
    expect(filesOf(repo, cCommit!)).toEqual(["c.txt"]);

    // The trace branch never touched the user's branch or working index.
    expect(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).not.toBe(TRACE);
    expect(runGit(repo, ["status", "--porcelain"])).toContain("?? a.txt"); // still merely untracked on the user's branch

    // The middle commit reverts cleanly in an isolated worktree (no conflict with the later write).
    const wt = `${repo}-wt`;
    dirs.push(wt);
    runGit(repo, ["worktree", "add", "-q", wt, TRACE]);
    let reverted = true;
    try {
      runGit(wt, ["revert", "--no-edit", bCommit!]);
    } catch {
      reverted = false;
    }
    expect(reverted).toBe(true);
    expect(existsSync(join(wt, "b.txt"))).toBe(false); // the reverted write is gone
    expect(existsSync(join(wt, "a.txt"))).toBe(true); // the others are untouched
    expect(existsSync(join(wt, "c.txt"))).toBe(true);
  });
});

describe("GitManager — clean branch (the curated narrative)", () => {
  it("promotes a two-concern section into two coherent commits while the trace keeps full granular history", async () => {
    const repo = setupRepo();
    const mgr = manager(repo);

    for (const rel of ["src/a/one.ts", "src/a/two.ts", "src/b/three.ts"]) {
      write(repo, rel, `// ${rel}\n`);
      await mgr.commitWrite(join(repo, rel), { sessionId: "s2", mode: "suggest" });
    }
    expect(shas(repo, TRACE)).toHaveLength(4); // three granular trace commits + base

    const sets = await mgr.planPromotion(repo, CLEAN);
    expect(sets).toHaveLength(2); // grouped by concern: src/a and src/b
    expect(sets[0]!.files.sort()).toEqual(["src/a/one.ts", "src/a/two.ts"]); // deterministic name order
    expect(sets[1]!.files).toEqual(["src/b/three.ts"]);

    await mgr.promote(sets, "auto");

    const cleanLog = shas(repo, CLEAN);
    expect(cleanLog).toHaveLength(3); // base + two promoted concerns
    expect(filesOf(repo, cleanLog[1]!)).toEqual(["src/a/one.ts", "src/a/two.ts"]); // first concern squashed to one commit
    expect(filesOf(repo, cleanLog[0]!)).toEqual(["src/b/three.ts"]); // second concern, its own commit

    // The trace branch is untouched by promotion — the granular flight recorder remains intact.
    expect(shas(repo, TRACE)).toHaveLength(4);
  });

  it("suggest mode surfaces the plan without applying it; auto mode applies it", async () => {
    const repo = setupRepo();
    const mgr = manager(repo);
    write(repo, "x.txt", "x\n");
    await mgr.commitWrite(join(repo, "x.txt"), { sessionId: "s3", mode: "suggest" });

    const sets = await mgr.planPromotion(repo, CLEAN);
    expect(sets.length).toBeGreaterThan(0);

    const before = runGit(repo, ["rev-parse", CLEAN]).trim();
    await mgr.promote(sets, "suggest");
    expect(runGit(repo, ["rev-parse", CLEAN]).trim()).toBe(before); // suggest applies nothing

    await mgr.promote(sets, "auto");
    expect(runGit(repo, ["rev-parse", CLEAN]).trim()).not.toBe(before); // auto advances the clean branch
  });
});

describe("GitManager — destructive operations are refused by construction", () => {
  it("never issues force-push, hard reset, rebase, or filter-branch — the runner is never even reached", async () => {
    const calls: string[][] = [];
    const spy: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(git(spy, "/repo", ["push", "--force"])).rejects.toThrow(/force-push/);
    await expect(git(spy, "/repo", ["push", "--force-with-lease", "origin", "main"])).rejects.toThrow(/force-push/);
    await expect(git(spy, "/repo", ["reset", "--hard", "HEAD~1"])).rejects.toThrow(/hard reset/);
    await expect(git(spy, "/repo", ["rebase", "main"])).rejects.toThrow(/history rewrite/);
    await expect(git(spy, "/repo", ["filter-branch", "--all"])).rejects.toThrow(/history rewrite/);
    expect(calls).toHaveLength(0); // the guard refuses before the command is ever run
  });
});
