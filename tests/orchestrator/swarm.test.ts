import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwarm, type SwarmDeps } from "../../src/orchestrator/swarm";
import type { MechanicalVerdict } from "../../src/orchestrator/verify-mechanical";
import type { AgentBackend } from "../../src/agents/backend";

const okAgent = (): AgentBackend =>
  ({
    id: "anthropic-cli",
    invoke: async () => ({
      ok: true,
      text: "done",
      usage: { inputTokens: 5000, outputTokens: 300, costUsd: 0.01, latencyMs: 10, model: "fake" },
      model: { providerKey: "anthropic-cli", model: "fake" },
    }),
    release: async () => {},
    health: async () => ({ up: true }),
    shutdown: async () => {},
  }) as unknown as AgentBackend;

const pass: MechanicalVerdict = { ok: true, stage: "passed", detail: "", diffBytes: 10, newDeps: [] };
const failV: MechanicalVerdict = { ok: false, stage: "verify-command", detail: "tests failed", diffBytes: 10, newDeps: [] };

const task = (id: string) => ({
  id, title: id, description: "d", files: [`src/${id}/`], acceptanceCriteria: [], dependsOn: [],
  status: "pending" as const, specRefs: [],
  brief: { objective: `do ${id}`, outputFormat: "commit", toolGuidance: "g", boundaries: "b" },
  compiledContext: "ctx",
});

function deps(over: Partial<SwarmDeps> = {}): SwarmDeps & { events: string[] } {
  const events: string[] = [];
  const leaseDir = mkdtempSync(join(tmpdir(), "cc-lease-"));
  return {
    runId: "run-1",
    tasks: [task("t1")],
    waves: [["t1"]],
    swarmConfig: { max_parallel_writers: 2, attempts_per_task: 2, task_wallclock_ms: 1000, run_wallclock_ms: 60_000 },
    workspace: {
      create: async (id: string, attempt: number) => {
        events.push(`create:${id}:a${attempt}`);
        return { path: `/wt/${id}-a${attempt}`, branch: `corpocode/run-1/${id}/a${attempt}` };
      },
      removeIfClean: async () => "removed" as const,
    },
    implementFor: () => okAgent(),
    verify: async (wt: string) => {
      events.push(`verify:${wt}`);
      return pass;
    },
    onWaveComplete: async (winners) => {
      events.push(`integrate:${winners.map((w) => w.taskId).join(",")}`);
    },
    budget: { wouldExceed: () => false, charge: () => {} },
    leaseDir,
    log: () => {},
    now: () => 1000,
    events,
    ...over,
  } as SwarmDeps & { events: string[] };
}

describe("runSwarm", () => {
  it("first passing attempt wins; no second attempt is spawned", async () => {
    const d = deps();
    const r = await runSwarm(d);
    expect(r.outcomes[0]).toMatchObject({ taskId: "t1", status: "completed", winner: { attempt: 1 } });
    expect(d.events.filter((e) => e.startsWith("create:"))).toEqual(["create:t1:a1"]);
    expect(d.events.at(-1)).toBe("integrate:t1"); // winners integrate at wave end
  });

  it("a failed attempt triggers a FRESH attempt (resample, not repair); K exhausted ⇒ failed", async () => {
    let calls = 0;
    const d = deps({ verify: async () => (++calls, failV) });
    const r = await runSwarm(d);
    expect(r.outcomes[0]!.status).toBe("failed");
    expect(r.outcomes[0]!.attempts).toHaveLength(2); // attempts_per_task = 2
    expect(calls).toBe(2);
  });

  it("halts before any attempt when the budget wall is hit", async () => {
    const d = deps({ budget: { wouldExceed: () => true, charge: () => {} } });
    const r = await runSwarm(d);
    expect(r.halted).toContain("budget");
    expect(d.events.filter((e) => e.startsWith("create:"))).toEqual([]);
  });

  it("halts when the run wall-clock cap is exceeded", async () => {
    let t = 0;
    const d = deps({ now: () => (t += 40_000) }); // clock jumps past run_wallclock_ms fast
    const r = await runSwarm(d);
    expect(r.halted).toContain("wall-clock");
  });

  it("skips a task whose fresh lease is already claimed; reaps a stale one", async () => {
    const d = deps();
    writeFileSync(join(d.leaseDir, "t1.json"), JSON.stringify({ taskId: "t1", claimedAt: 900, expiresAt: 999_999 }));
    const r1 = await runSwarm(d);
    expect(r1.outcomes[0]!.status).toBe("skipped");
    rmSync(join(d.leaseDir, "t1.json"));

    const d2 = deps();
    writeFileSync(join(d2.leaseDir, "t1.json"), JSON.stringify({ taskId: "t1", claimedAt: 1, expiresAt: 2 })); // stale
    const r2 = await runSwarm(d2);
    expect(r2.outcomes[0]!.status).toBe("completed");
  });

  it("waves execute in order: wave 2 starts after wave 1 integrates", async () => {
    const d = deps({ tasks: [task("t1"), task("t2")], waves: [["t1"], ["t2"]] });
    await runSwarm(d);
    const idx = (e: string) => d.events.indexOf(e);
    expect(idx("integrate:t1")).toBeGreaterThan(idx("create:t1:a1"));
    expect(idx("create:t2:a1")).toBeGreaterThan(idx("integrate:t1"));
  });
});
