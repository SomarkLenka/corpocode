import { describe, expect, it, vi } from "vitest";
import { gcRuns } from "../../src/orchestrator/gc";
import type { CommandRunner } from "../../src/install/run";
import type { RunRecord } from "../../src/orchestrator/run";

type Rule = { match: (args: string[]) => boolean; code?: number; stdout?: string };

function fakeRunner(rules: Rule[] = []) {
  const calls: string[][] = [];
  const run: CommandRunner = async (_cmd, args) => {
    calls.push(args);
    const rule = rules.find((r) => r.match(args));
    return { code: rule?.code ?? 0, stdout: rule?.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

function mkRun(id: string, createdAt: number): RunRecord {
  return { id, task: "t", status: "done", createdAt, updatedAt: createdAt };
}

const NOW = 1_000_000_000_000;
const TTL = 14 * 24 * 60 * 60 * 1000; // 14 days in ms

const isBranchList = (a: string[]) => a[0] === "branch" && a.includes("--list");
const isBranchDelete = (a: string[]) => a[0] === "branch" && a.includes("-D");
const isWorktreePrune = (a: string[]) => a[0] === "worktree" && a.includes("prune");

// A branch --list rule that returns two branches (with git's leading whitespace / current marker).
const listRule = (runId: string): Rule => ({
  match: (a) => isBranchList(a) && a.some((s) => s.includes(runId)),
  stdout: `  corpocode/${runId}/integration\n* corpocode/${runId}/t1/a1\n`,
});

describe("gcRuns", () => {
  it("collects an expired run: deletes each branch, removes its dir, prunes worktrees", async () => {
    const expired = mkRun("run-old", NOW - TTL - 1);
    const { run, calls } = fakeRunner([listRule("run-old")]);
    const removeDir = vi.fn();
    const res = await gcRuns({
      runs: [expired],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir,
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });

    expect(res.collected).toEqual(["run-old"]);
    expect(res.kept).toEqual([]);

    const deletes = calls.filter(isBranchDelete);
    expect(deletes).toEqual([
      ["branch", "-D", "corpocode/run-old/integration"],
      ["branch", "-D", "corpocode/run-old/t1/a1"],
    ]);
    expect(removeDir).toHaveBeenCalledTimes(1);
    expect(removeDir).toHaveBeenCalledWith("/repo/.corpocode/runs/run-old");
    expect(calls.filter(isWorktreePrune)).toHaveLength(1);
  });

  it("keeps a fresh run: no branch -D, no removeDir, no prune", async () => {
    const fresh = mkRun("run-new", NOW - 1000); // well within ttl
    const { run, calls } = fakeRunner([listRule("run-new")]);
    const removeDir = vi.fn();
    const res = await gcRuns({
      runs: [fresh],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir,
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });

    expect(res.collected).toEqual([]);
    expect(res.kept).toEqual(["run-new"]);
    expect(calls.filter(isBranchDelete)).toEqual([]);
    expect(removeDir).not.toHaveBeenCalled();
    expect(calls.filter(isWorktreePrune)).toHaveLength(0);
  });

  it("partitions a mixed set correctly", async () => {
    const expired = mkRun("run-old", NOW - TTL - 1);
    const fresh = mkRun("run-new", NOW - 1000);
    const { run, calls } = fakeRunner([listRule("run-old"), listRule("run-new")]);
    const removeDir = vi.fn();
    const res = await gcRuns({
      runs: [expired, fresh],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir,
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });

    expect(res.collected).toEqual(["run-old"]);
    expect(res.kept).toEqual(["run-new"]);
    // Only the expired run's branches are deleted / dir removed.
    expect(removeDir).toHaveBeenCalledTimes(1);
    expect(removeDir).toHaveBeenCalledWith("/repo/.corpocode/runs/run-old");
    expect(calls.filter(isBranchDelete).every((a) => a[2]!.includes("run-old"))).toBe(true);
    expect(calls.filter(isWorktreePrune)).toHaveLength(1);
  });

  it("does not prune when nothing expired", async () => {
    const fresh = mkRun("run-new", NOW);
    const { run, calls } = fakeRunner([listRule("run-new")]);
    const res = await gcRuns({
      runs: [fresh],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir: () => {},
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });
    expect(res.collected).toEqual([]);
    expect(calls.filter(isWorktreePrune)).toHaveLength(0);
  });

  it("is best-effort: a failed branch delete still removes the dir and collects the run", async () => {
    const expired = mkRun("run-old", NOW - TTL - 1);
    const { run } = fakeRunner([
      listRule("run-old"),
      { match: isBranchDelete, code: 1 }, // deletes throw GitError -> swallowed
    ]);
    const removeDir = vi.fn();
    const res = await gcRuns({
      runs: [expired],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir,
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });
    expect(res.collected).toEqual(["run-old"]);
    expect(removeDir).toHaveBeenCalledTimes(1);
  });

  it("keeps a run exactly at the ttl boundary (now - createdAt === ttlMs)", async () => {
    const boundary = mkRun("run-edge", NOW - TTL);
    const { run } = fakeRunner([listRule("run-edge")]);
    const res = await gcRuns({
      runs: [boundary],
      repoRoot: "/repo",
      run,
      ttlMs: TTL,
      now: NOW,
      removeDir: () => {},
      runDirOf: (id) => `/repo/.corpocode/runs/${id}`,
    });
    expect(res.kept).toEqual(["run-edge"]);
    expect(res.collected).toEqual([]);
  });
});
