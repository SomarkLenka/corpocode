import { describe, expect, it } from "vitest";
import { verifyCandidate } from "../../src/orchestrator/verify-mechanical";
import type { CommandRunner } from "../../src/install/run";

type Rule = { match: (args: string[]) => boolean; code?: number; stdout?: string; stderr?: string };

function fakeRunner(rules: Rule[]) {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const run: CommandRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    const rule = rules.find((r) => r.match(args));
    return { code: rule?.code ?? 0, stdout: rule?.stdout ?? "", stderr: rule?.stderr ?? "" };
  };
  return { run, calls };
}

const TASK = { id: "t1", verifyCommand: "npx vitest run tests/theme" };
const DIFF = "+++ b/src/ui/theme.ts\n+export const x = 1;\n";

const baseRules: Rule[] = [
  { match: (a) => a[0] === "status", stdout: "" },
  { match: (a) => a[0] === "diff", stdout: DIFF },
];

describe("verifyCandidate", () => {
  it("passes a committed, dep-clean, test-green candidate", async () => {
    const { run, calls } = fakeRunner(baseRules);
    const v = await verifyCandidate({ worktree: "/wt", baseBranch: "corpocode/r/integration", task: TASK, run, depgate: { enabled: true, allowlist: new Set() } });
    expect(v).toMatchObject({ ok: true, stage: "passed" });
    expect(v.diffBytes).toBeGreaterThan(0);
    // verify command ran inside the worktree via a shell wrapper
    const verifyCall = calls.find((c) => c.cmd !== "git");
    expect(verifyCall!.cwd).toBe("/wt");
  });

  it("auto-checkpoints uncommitted work before diffing", async () => {
    const { run, calls } = fakeRunner([{ match: (a) => a[0] === "status", stdout: " M src/x.ts\n" }, { match: (a) => a[0] === "diff", stdout: DIFF }]);
    await verifyCandidate({ worktree: "/wt", baseBranch: "b", task: TASK, run, depgate: { enabled: false, allowlist: new Set() } });
    expect(calls.some((c) => c.args[0] === "add")).toBe(true);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(true);
  });

  it("fails with no-commits when the diff is empty", async () => {
    const { run } = fakeRunner([{ match: (a) => a[0] === "status", stdout: "" }, { match: (a) => a[0] === "diff", stdout: "" }]);
    const v = await verifyCandidate({ worktree: "/wt", baseBranch: "b", task: TASK, run, depgate: { enabled: false, allowlist: new Set() } });
    expect(v).toMatchObject({ ok: false, stage: "no-commits" });
  });

  it("fails at the depgate when the diff adds a non-allowlisted dependency", async () => {
    const depDiff = '+++ b/package.json\n+    "evil-pkg": "1.0.0",\n';
    const { run, calls } = fakeRunner([{ match: (a) => a[0] === "status", stdout: "" }, { match: (a) => a[0] === "diff", stdout: depDiff }]);
    const v = await verifyCandidate({ worktree: "/wt", baseBranch: "b", task: TASK, run, depgate: { enabled: true, allowlist: new Set(["zod"]) } });
    expect(v).toMatchObject({ ok: false, stage: "depgate" });
    expect(v.newDeps[0]!.name).toBe("evil-pkg");
    expect(calls.some((c) => c.cmd !== "git")).toBe(false); // never ran the verify command
  });

  it("fails at verify-command on a non-zero exit", async () => {
    const { run } = fakeRunner([...baseRules.slice(0, 2), { match: (a) => a.join(" ").includes("vitest"), code: 1, stderr: "2 tests failed" }]);
    const v = await verifyCandidate({ worktree: "/wt", baseBranch: "b", task: TASK, run, depgate: { enabled: false, allowlist: new Set() } });
    expect(v).toMatchObject({ ok: false, stage: "verify-command" });
    expect(v.detail).toContain("2 tests failed");
  });
});
