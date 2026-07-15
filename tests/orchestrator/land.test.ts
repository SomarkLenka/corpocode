import { describe, expect, it } from "vitest";
import { integrate, conflictTasks } from "../../src/orchestrator/land";
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

const winners = [
  { taskId: "t1", branch: "corpocode/r/t1/a1" },
  { taskId: "t2", branch: "corpocode/r/t2/a1" },
];

describe("integrate", () => {
  it("merges winners one at a time with --no-ff", async () => {
    const { run, calls } = fakeRunner();
    const out = await integrate({ repoRoot: "/repo", integrationBranch: "corpocode/r/integration", integrationWorktree: "/repo/.corpocode/runs/r/worktrees/_integration", winners, run });
    expect(out.merged.map((m) => m.taskId)).toEqual(["t1", "t2"]);
    expect(out.conflicts).toEqual([]);
    const merges = calls.filter((a) => a[0] === "merge");
    expect(merges).toHaveLength(2);
    expect(merges[0]).toContain("--no-ff");
    expect(merges[0]).toContain("corpocode/r/t1/a1");
  });

  it("aborts a conflicted merge, records it, and continues the train", async () => {
    const { run, calls } = fakeRunner([
      { match: (a) => a[0] === "merge" && a.includes("corpocode/r/t1/a1"), code: 1 },
      { match: (a) => a[0] === "diff" && a.includes("--diff-filter=U"), stdout: "src/ui/theme.ts\n" },
    ]);
    const out = await integrate({ repoRoot: "/repo", integrationBranch: "corpocode/r/integration", integrationWorktree: "/wt/_integration", winners, run });
    expect(out.conflicts).toEqual([{ taskId: "t1", branch: "corpocode/r/t1/a1", files: ["src/ui/theme.ts"] }]);
    expect(out.merged.map((m) => m.taskId)).toEqual(["t2"]); // train continues past the conflict
    expect(calls.some((a) => a[0] === "merge" && a.includes("--abort"))).toBe(true);
  });
});

describe("conflictTasks", () => {
  it("converts a conflict into a normal cheap-authored resolution task", () => {
    const original = {
      id: "t1", title: "theme", description: "d", files: ["src/ui/"], acceptanceCriteria: ["WHEN x THE SYSTEM SHALL y"],
      dependsOn: [], status: "completed" as const, specRefs: ["ac1"],
    };
    const [task] = conflictTasks([{ taskId: "t1", branch: "corpocode/r/t1/a1", files: ["src/ui/theme.ts"] }], [original]);
    expect(task!.id).toBe("t1-conflict-1");
    expect(task!.status).toBe("pending");
    expect(task!.files).toEqual(["src/ui/theme.ts"]);
    expect(task!.description).toContain("corpocode/r/t1/a1"); // the branch carrying the unmerged work
    expect(task!.acceptanceCriteria).toEqual(original.acceptanceCriteria); // acceptance carries over
    expect(task!.specRefs).toEqual(["ac1"]);
  });
});
