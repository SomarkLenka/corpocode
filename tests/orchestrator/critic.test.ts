import { describe, expect, it } from "vitest";
import { critiquePlan } from "../../src/orchestrator/critic";
import type { AgentBackend, AgentCall } from "../../src/agents/backend";

/** Fake backend per ADR-0001 — records the call, returns a canned result. */
function fakeBackend(result: { ok: boolean; data?: unknown; errorMessage?: string }) {
  const calls: AgentCall[] = [];
  const backend = {
    id: "anthropic-cli",
    invoke: async <T,>(call: AgentCall<T>) => {
      calls.push(call as AgentCall);
      return {
        ok: result.ok,
        data: result.data as T | undefined,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001, latencyMs: 5, model: "fake" },
        model: { providerKey: "anthropic-cli", model: "fake" },
        ...(result.errorMessage ? { error: { kind: "model_unavailable", message: result.errorMessage, retryable: false } } : {}),
      };
    },
    release: async () => {},
    health: async () => ({ up: true }),
    shutdown: async () => {},
  } as unknown as AgentBackend;
  return { backend, calls };
}

const task = {
  id: "t1",
  title: "x",
  description: "y",
  files: ["src/a/"],
  acceptanceCriteria: ["WHEN a THE SYSTEM SHALL b"],
  dependsOn: [],
  status: "pending" as const,
  specRefs: ["ac1"],
  brief: { objective: "o", outputFormat: "f", toolGuidance: "g", boundaries: "b" },
  compiledContext: "ctx",
};

describe("critiquePlan", () => {
  it("returns ok:false when the critic reports a block finding", async () => {
    const { backend, calls } = fakeBackend({
      ok: true,
      data: { findings: [{ taskId: "t1", severity: "block", note: "task touches files it doesn't list" }] },
    });
    const report = await critiquePlan({ backend, tasks: [task] });
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.severity).toBe("block");
    // the critic must be a read-nothing reviewer: no tools, structured output, review kind
    expect(calls[0]!.taskKind).toBe("review");
    expect(calls[0]!.tools).toBe("none");
    expect(calls[0]!.schema).toBeDefined();
  });

  it("warn/info findings do not block", async () => {
    const { backend } = fakeBackend({ ok: true, data: { findings: [{ taskId: "t1", severity: "warn", note: "thin verify command" }] } });
    const report = await critiquePlan({ backend, tasks: [task] });
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(1);
  });

  it("fails open: a dead backend yields ok:true with skipped reason", async () => {
    const { backend } = fakeBackend({ ok: false, errorMessage: "claude not found" });
    const report = await critiquePlan({ backend, tasks: [task] });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toContain("claude not found");
  });
});
