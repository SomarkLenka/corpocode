import { describe, expect, it } from "vitest";
import {
  buildPredictions,
  toJsonl,
  type PredictionEntry,
  type PredictionInput,
} from "../../src/bench/predictions";

describe("buildPredictions", () => {
  it("maps each input to a SWE-bench entry with the required snake_case keys + model name", () => {
    const inputs: PredictionInput[] = [
      { instanceId: "django__django-1", patch: "diff-a" },
      { instanceId: "sympy__sympy-2", patch: "diff-b" },
    ];
    const entries = buildPredictions(inputs, "corpocode-swarm");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      instance_id: "django__django-1",
      model_name_or_path: "corpocode-swarm",
      model_patch: "diff-a",
    });
    // input order preserved
    expect(entries[1]!.instance_id).toBe("sympy__sympy-2");
    expect(entries[1]!.model_name_or_path).toBe("corpocode-swarm");
  });

  it("carries optional cost_usd and resolved annotations when present, omits when absent", () => {
    const inputs: PredictionInput[] = [
      { instanceId: "a", patch: "p", costUsd: 0.12, resolved: true },
      { instanceId: "b", patch: "q" },
    ];
    const [withAnn, without] = buildPredictions(inputs, "m");
    expect(withAnn).toMatchObject({ cost_usd: 0.12, resolved: true });
    expect(without.cost_usd).toBeUndefined();
    expect(without.resolved).toBeUndefined();
  });
});

describe("toJsonl", () => {
  it("emits N newline-terminated lines that round-trip through JSON.parse", () => {
    const entries: PredictionEntry[] = [
      { instance_id: "a", model_name_or_path: "m", model_patch: "pa" },
      { instance_id: "b", model_name_or_path: "m", model_patch: "pb", cost_usd: 0.5, resolved: false },
    ];
    const jsonl = toJsonl(entries);
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(entries[0]);
    expect(JSON.parse(lines[1]!)).toEqual(entries[1]);
  });

  it("returns an empty string for empty input", () => {
    expect(toJsonl([])).toBe("");
  });
});
