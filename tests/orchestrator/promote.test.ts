import { describe, expect, it, vi } from "vitest";
import { promoteToClean } from "../../src/orchestrator/promote";
import type { CommandRunner } from "../../src/install/run";

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

const isRevParse = (a: string[]) => a[0] === "rev-parse" && a.includes("--verify");

describe("promoteToClean", () => {
  it("creates the clean branch when it is absent", async () => {
    // rev-parse returns code 1 => branch does not exist.
    const { run, calls } = fakeRunner([{ match: isRevParse, code: 1 }]);
    const res = await promoteToClean({
      repoRoot: "/repo",
      runId: "run-1",
      integrationBranch: "corpocode/run-1/integration",
      run,
    });
    expect(res.cleanBranch).toBe("corpocode/run-1/clean");
    expect(res.created).toBe(true);
    const branchCalls = calls.filter((a) => a[0] === "branch");
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]).toEqual(["branch", "corpocode/run-1/clean", "corpocode/run-1/integration"]);
    // Must NOT force-update when creating fresh.
    expect(branchCalls[0]).not.toContain("-f");
  });

  it("force-updates the clean branch when it already exists", async () => {
    // rev-parse returns code 0 => branch exists.
    const { run, calls } = fakeRunner([{ match: isRevParse, code: 0 }]);
    const res = await promoteToClean({
      repoRoot: "/repo",
      runId: "run-1",
      integrationBranch: "corpocode/run-1/integration",
      run,
    });
    expect(res.cleanBranch).toBe("corpocode/run-1/clean");
    expect(res.created).toBe(false);
    const branchCalls = calls.filter((a) => a[0] === "branch");
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]).toEqual(["branch", "-f", "corpocode/run-1/clean", "corpocode/run-1/integration"]);
  });

  it("logs the promotion", async () => {
    const log = vi.fn();
    const { run } = fakeRunner([{ match: isRevParse, code: 1 }]);
    await promoteToClean({
      repoRoot: "/repo",
      runId: "run-1",
      integrationBranch: "corpocode/run-1/integration",
      run,
      log,
    });
    expect(log).toHaveBeenCalled();
  });
});
