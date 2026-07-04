// The decompose funnel: deterministic emit first (complete seeds cost zero model calls), the
// agent only for gaps, one corrective retry with the fatal issues fed back, then the caller
// escalates. Agents are fakes throughout (house rule: no test invokes a real model).
import { describe, expect, it } from "vitest";
import { decompose, validateTasks, validateImportedPlan } from "../../src/orchestrator/decompose";
import { specSchema, type Spec } from "../../src/um/spec-schema";
import type { AgentResult } from "../../src/agents/backend";

function spec(seeds: unknown[], acceptance: unknown[] = []): Spec {
  return specSchema.parse({ runId: "r", task: "t", taskSeeds: seeds, acceptance });
}

const completeSeed = (id: string, deps: string[] = []) => ({
  id,
  title: id,
  description: "d",
  files: [`src/${id}.ts`],
  dependsOn: deps,
  verifyCommand: "npm test",
  acceptanceRefs: ["a1"],
});

const ACCEPT = [{ id: "a1", criterion: "HTTP 200 from /health", verify: { method: "command", command: "curl -f /health" } }];

function ok(data: unknown): AgentResult {
  return { ok: true, data, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.05, latencyMs: 1, model: "m" }, model: { providerKey: "p", model: "m" } };
}

describe("validateTasks", () => {
  const base = { title: "", description: "", acceptanceCriteria: ["c"], status: "pending" as const, specRefs: [], tags: [] };

  it("flags missing verifyCommand and empty criteria as fatal", () => {
    const issues = validateTasks({
      version: 1,
      tasks: [
        { ...base, id: "a", files: [], dependsOn: [], verifyCommand: " ", acceptanceCriteria: ["c"] },
        { ...base, id: "b", files: [], dependsOn: [], verifyCommand: "npm test", acceptanceCriteria: [] },
      ],
    });
    expect(issues.map((i) => `${i.kind}:${i.detail}`).sort()).toEqual(["empty-criteria:b", "missing-verify:a"]);
    expect(issues.every((i) => i.fatal)).toBe(true);
  });

  it("flags cycles and unknown deps as fatal, naming the path", () => {
    const issues = validateTasks({
      version: 1,
      tasks: [
        { ...base, id: "a", files: [], dependsOn: ["b"], verifyCommand: "v" },
        { ...base, id: "b", files: [], dependsOn: ["a", "ghost"], verifyCommand: "v" },
      ],
    });
    expect(issues.some((i) => i.kind === "unknown-dep" && i.detail === "b -> ghost")).toBe(true);
    expect(issues.some((i) => i.kind === "cycle" && i.detail.includes("a -> b -> a"))).toBe(true);
  });

  it("flags file overlap between CONCURRENT tasks as non-fatal, but not between ordered ones", () => {
    const issues = validateTasks({
      version: 1,
      tasks: [
        { ...base, id: "a", files: ["shared.ts"], dependsOn: [], verifyCommand: "v" },
        { ...base, id: "b", files: ["shared.ts"], dependsOn: [], verifyCommand: "v" },
        { ...base, id: "c", files: ["shared.ts"], dependsOn: ["a"], verifyCommand: "v" }, // ordered after a
      ],
    });
    const overlaps = issues.filter((i) => i.kind === "file-overlap");
    expect(overlaps).toHaveLength(2); // a∩b and b∩c (both unordered); never a∩c
    expect(overlaps.every((i) => !i.fatal)).toBe(true);
    expect(overlaps.some((i) => i.detail.startsWith("a ∩ c"))).toBe(false);
  });
});

describe("decompose", () => {
  it("complete seeds never reach the agent (tier 1: zero model cost)", async () => {
    let invoked = 0;
    const result = await decompose(spec([completeSeed("a"), completeSeed("b", ["a"])], ACCEPT), {
      invoke: async () => (invoked++, ok({})),
      renderPrompt: () => "p",
    });
    expect(invoked).toBe(0);
    expect(result).toMatchObject({ ok: true, usedAgent: false, costUsd: 0 });
    if (result.ok) expect(result.file.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("incomplete seeds go to the agent; a valid graph on attempt 1 wins", async () => {
    const prompts: string[] = [];
    const result = await decompose(spec([{ ...completeSeed("a"), verifyCommand: undefined }], ACCEPT), {
      invoke: async () => ok({ taskSeeds: [{ ...completeSeed("a"), acceptanceCriteria: ["HTTP 200 from /health"], modelTier: "standard" }] }),
      renderPrompt: (_s, feedback) => (prompts.push(feedback ?? ""), "p"),
    });
    expect(result).toMatchObject({ ok: true, usedAgent: true, costUsd: 0.05 });
    expect(prompts[0]).toContain("missing-verify"); // the deterministic failure seeds the first prompt
    if (result.ok) expect(result.file.tasks[0]).toMatchObject({ modelTier: "standard" });
  });

  it("feeds fatal issues back on retry, then reports the last error when attempts run dry", async () => {
    const feedbacks: string[] = [];
    const bad = { taskSeeds: [{ id: "x", title: "x", files: [], dependsOn: ["ghost"], verifyCommand: "v", acceptanceCriteria: ["c"] }] };
    const result = await decompose(spec([{ ...completeSeed("a"), verifyCommand: undefined }], ACCEPT), {
      invoke: async () => ok(bad),
      renderPrompt: (_s, feedback) => (feedbacks.push(feedback ?? ""), "p"),
      maxAttempts: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown-dep: x -> ghost");
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toContain("unknown-dep"); // the retry saw the first attempt's failure
    expect(result.costUsd).toBeCloseTo(0.1);
  });

  it("a dead agent (fail-open result) exhausts attempts without throwing", async () => {
    const result = await decompose(spec([{ ...completeSeed("a"), verifyCommand: undefined }], ACCEPT), {
      invoke: async () => ({ ok: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: "" }, model: { providerKey: "", model: "" }, error: { kind: "timeout", message: "agent exceeded 1ms", retryable: true } }),
      renderPrompt: () => "p",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agent exceeded");
  });
});

describe("validateImportedPlan", () => {
  it("parses and validates in one step; junk is null", () => {
    const good = validateImportedPlan({ version: 1, tasks: [{ id: "a", verifyCommand: "v", acceptanceCriteria: ["c"] }] });
    expect(good).not.toBeNull();
    expect(good!.issues).toEqual([]);
    expect(validateImportedPlan("junk")).toBeNull();
  });
});
