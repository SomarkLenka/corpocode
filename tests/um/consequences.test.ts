import { describe, it, expect } from "vitest";
import { AXIS_FINDING_JSON_SCHEMA, consequencePlan } from "../../src/um/consequences";
import type { DecisionFork } from "../../src/um/types";

const fork: DecisionFork = {
  id: "storage-choice",
  section: "api-spec",
  concept: "persistence",
  question: "SQLite or flat JSON?",
  options: [
    { id: "a", label: "SQLite", description: "embedded db" },
    { id: "b", label: "JSON files" },
  ],
  major: true,
};

const cfg = {
  axes: ["performance", "failure-modes", "idiom"],
  fanoutWidth: 4,
  component: "um" as const,
  model: { providerKey: "default", model: "cheap-1" },
  effort: "minimal" as const,
  timeoutMs: 30_000,
  files: ["src/a.ts", "src/b.ts"],
  renderPrompt: (axis: string, option: { id: string; label: string }) => `analyze ${option.label} on ${axis}`,
};

describe("consequencePlan", () => {
  it("emits one task per option x axis with stable `${option.id}::${axis}` ids", () => {
    const plan = consequencePlan(fork, cfg);
    expect(plan.tasks.map((t) => t.id)).toEqual([
      "a::performance",
      "a::failure-modes",
      "a::idiom",
      "b::performance",
      "b::failure-modes",
      "b::idiom",
    ]);
    expect(plan.fanoutWidth).toBe(4);
  });

  it("every call is a read-only ephemeral consequence task with the finding schema", () => {
    const plan = consequencePlan(fork, cfg);
    for (const task of plan.tasks) {
      expect(task.call.taskKind).toBe("consequence");
      expect(task.call.tools).toBe("read-only");
      expect(task.call.session).toBe("ephemeral");
      expect(task.call.schema).toBe(AXIS_FINDING_JSON_SCHEMA);
      expect(task.call.component).toBe("um");
      expect(task.call.effort).toBe("minimal");
      expect(task.call.model).toEqual({ providerKey: "default", model: "cheap-1" });
      expect(task.call.timeoutMs).toBe(30_000);
      expect(task.call.inputs?.files).toEqual(["src/a.ts", "src/b.ts"]);
    }
  });

  it("renders the prompt per option x axis via the injected renderer", () => {
    const plan = consequencePlan(fork, cfg);
    expect(plan.tasks[0]!.call.task).toBe("analyze SQLite on performance");
    expect(plan.tasks[5]!.call.task).toBe("analyze JSON files on idiom");
  });

  it("keeps failed tasks in the result (keep-all judge) so poll-synth can render the gap", () => {
    const plan = consequencePlan(fork, cfg);
    const failed = [{ id: "x", result: { ok: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: "" }, model: { providerKey: "", model: "" } } }];
    expect(plan.judge!(failed as never)).toHaveLength(1);
  });

  it("omits inputs when no grounding files are given", () => {
    const plan = consequencePlan(fork, { ...cfg, files: undefined });
    expect(plan.tasks[0]!.call.inputs).toBeUndefined();
  });
});
