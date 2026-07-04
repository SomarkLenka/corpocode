import { describe, it, expect } from "vitest";
import { renderTeaching, synthesizePoll } from "../../src/um/poll-synth";
import type { AxisFindingPayload } from "../../src/um/consequences";
import type { DecisionFork } from "../../src/um/types";
import type { AgentTaskResult } from "../../src/intelligence/types";

const fork: DecisionFork = {
  id: "f1",
  section: "api-spec",
  concept: "persistence",
  question: "SQLite or JSON?",
  options: [
    { id: "a", label: "SQLite" },
    { id: "b", label: "JSON" },
  ],
  major: true,
};

const ok = (id: string, severity: AxisFindingPayload["severity"], summary = `s-${id}`): AgentTaskResult<AxisFindingPayload> => ({
  id,
  result: {
    ok: true,
    data: { summary, severity },
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 1, model: "m" },
    model: { providerKey: "p", model: "m" },
  },
});

const failed = (id: string): AgentTaskResult<AxisFindingPayload> => ({
  id,
  result: {
    ok: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: "" },
    model: { providerKey: "", model: "" },
    error: { kind: "timeout", message: "t", retryable: true },
  },
});

describe("synthesizePoll", () => {
  it("maps every option x axis to a finding and recommends the majority-of-axes winner", () => {
    const axes = ["perf", "maint", "fail"];
    // perf: a wins; maint: b wins; fail: a wins → a has 2 axis wins → recommended + default
    const results = [
      ok("a::perf", "info"), ok("b::perf", "risk"),
      ok("a::maint", "warn"), ok("b::maint", "info"),
      ok("a::fail", "info"), ok("b::fail", "warn"),
    ];
    const poll = synthesizePoll(fork, results, { axes, allowDelegate: true });
    expect(poll.id).toBe("f1");
    expect(poll.options.map((o) => o.findings.length)).toEqual([3, 3]);
    expect(poll.options[0]!.recommended).toBe(true);
    expect(poll.options[1]!.recommended).toBeUndefined();
    expect(poll.defaultOptionId).toBe("a");
    expect(poll.allowFreeText).toBe(true);
    expect(poll.allowDelegate).toBe(true);
    const f = poll.options[0]!.findings[0]!;
    expect(f).toEqual({ axis: "perf", optionId: "a", summary: "s-a::perf", severity: "info", ok: true });
  });

  it("renders a missing or failed task as an explicit unanalyzed finding", () => {
    const axes = ["perf", "maint"];
    const results = [ok("a::perf", "info"), failed("b::perf")]; // maint entirely missing
    const poll = synthesizePoll(fork, results, { axes, allowDelegate: false });
    const bPerf = poll.options[1]!.findings.find((f) => f.axis === "perf")!;
    expect(bPerf).toEqual({ axis: "perf", optionId: "b", summary: "unanalyzed", severity: "info", ok: false });
    const aMaint = poll.options[0]!.findings.find((f) => f.axis === "maint")!;
    expect(aMaint.ok).toBe(false);
    expect(aMaint.summary).toBe("unanalyzed");
  });

  it("treats an ok result with a malformed payload as unanalyzed", () => {
    const bad: AgentTaskResult<AxisFindingPayload> = {
      ...ok("a::perf", "info"),
      result: { ...ok("a::perf", "info").result, data: { nope: 1 } as never },
    };
    const poll = synthesizePoll(fork, [bad], { axes: ["perf"], allowDelegate: true });
    expect(poll.options[0]!.findings[0]!.ok).toBe(false);
  });

  it("an overall tie yields NO recommendation and NO defaultOptionId (dead interactor ⇒ pause)", () => {
    const axes = ["perf", "maint"];
    // perf: a wins; maint: b wins → 1 win each → tie
    const results = [
      ok("a::perf", "info"), ok("b::perf", "warn"),
      ok("a::maint", "risk"), ok("b::maint", "info"),
    ];
    const poll = synthesizePoll(fork, results, { axes, allowDelegate: true });
    expect(poll.options.every((o) => o.recommended === undefined)).toBe(true);
    expect(poll.defaultOptionId).toBeUndefined();
  });

  it("an axis where all options tie has no winner and cannot decide the poll", () => {
    const axes = ["perf", "maint", "fail"];
    // perf: all warn (no winner); maint: a wins; fail: b wins → still an overall tie
    const results = [
      ok("a::perf", "warn"), ok("b::perf", "warn"),
      ok("a::maint", "info"), ok("b::maint", "warn"),
      ok("a::fail", "risk"), ok("b::fail", "info"),
    ];
    const poll = synthesizePoll(fork, results, { axes, allowDelegate: true });
    expect(poll.defaultOptionId).toBeUndefined();
  });

  it("is deterministic — same findings, same poll", () => {
    const axes = ["perf"];
    const results = [ok("a::perf", "info"), ok("b::perf", "risk")];
    const one = synthesizePoll(fork, results, { axes, allowDelegate: true });
    const two = synthesizePoll(fork, results, { axes, allowDelegate: true });
    expect(two).toEqual(one);
  });
});

describe("renderTeaching", () => {
  it("digests computed (ok) findings per option, skipping unanalyzed cells, with zero model calls", () => {
    const findings = [
      { axis: "perf", optionId: "a", summary: "fast reads", severity: "info" as const, ok: true },
      { axis: "perf", optionId: "b", summary: "unanalyzed", severity: "info" as const, ok: false },
    ];
    const block = renderTeaching(fork, findings);
    expect(block.concept).toBe("persistence");
    expect(block.body).toContain('"persistence"');
    expect(block.body).toContain("SQLite or JSON?");
    expect(block.body).toContain("SQLite: perf (info): fast reads");
    expect(block.body).toContain("JSON: no analyzed consequences");
    // deterministic
    expect(renderTeaching(fork, findings)).toEqual(block);
  });
});
