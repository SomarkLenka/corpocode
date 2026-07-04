import { describe, it, expect } from "vitest";
import {
  initialState,
  isComplete,
  nextOpenSection,
  recordContent,
  recordDecision,
  sectionPayloadSchema,
} from "../../src/um/interrogator";
import { SPEC_SECTIONS } from "../../src/um/types";
import type { DecisionRecord } from "../../src/um/types";
import { specSchema } from "../../src/um/spec-schema";

const decision = (section: DecisionRecord["section"], pollId = "p1"): DecisionRecord => ({
  pollId,
  section,
  concept: "c",
  question: "q?",
  options: [{ id: "a", label: "A", findings: [] }],
  answer: { pollId, optionId: "a", source: "pilot" },
  at: 1,
});

describe("initialState", () => {
  it("opens all 7 sections with zero polls and a schema-valid spec", () => {
    const state = initialState("run-1", "build a thing");
    expect(Object.keys(state.spec.sections)).toHaveLength(7);
    for (const s of SPEC_SECTIONS) expect(state.spec.sections[s]).toBe("open");
    expect(state.polls).toBe(0);
    expect(() => specSchema.parse(state.spec)).not.toThrow();
    expect(state.spec.runId).toBe("run-1");
    expect(state.spec.task).toBe("build a thing");
  });
});

describe("recordDecision", () => {
  it("appends to the ledger, bumps polls, and moves the section open → in-progress", () => {
    const s0 = initialState("r", "t");
    const s1 = recordDecision(s0, decision("api-spec"));
    expect(s1.spec.decisions).toHaveLength(1);
    expect(s1.polls).toBe(1);
    expect(s1.spec.sections["api-spec"]).toBe("in-progress");
    // immutability: the prior state is untouched
    expect(s0.spec.decisions).toHaveLength(0);
    expect(s0.polls).toBe(0);
    expect(s0.spec.sections["api-spec"]).toBe("open");
  });

  it("never reopens a complete section (late/escalation decisions)", () => {
    let s = initialState("r", "t");
    s = recordContent(s, "api-spec", {}, true);
    s = recordDecision(s, decision("api-spec", "p2"));
    expect(s.spec.sections["api-spec"]).toBe("complete");
  });
});

describe("recordContent", () => {
  it("merges arrays additively and marks the section in-progress", () => {
    const s0 = initialState("r", "t");
    const s1 = recordContent(s0, "api-spec", { constraints: ["c1"], entities: [{ name: "User", description: "d", fields: [] }] }, false);
    expect(s1.spec.constraints).toEqual(["c1"]);
    expect(s1.spec.entities.map((e) => e.name)).toEqual(["User"]);
    expect(s1.spec.sections["api-spec"]).toBe("in-progress");
    expect(s0.spec.constraints).toEqual([]); // immutability
  });

  it("dedupes keyed items — a re-emitted name/id replaces in place, order preserved", () => {
    let s = initialState("r", "t");
    s = recordContent(s, "api-spec", {
      entities: [{ name: "User", description: "v1", fields: [] }, { name: "Team", description: "t1", fields: [] }],
      taskSeeds: [{ id: "t1", title: "one", description: "d", files: [], dependsOn: [], acceptanceRefs: [], tags: [] }],
      constraints: ["c1", "c2"],
    }, false);
    s = recordContent(s, "api-spec", {
      entities: [{ name: "User", description: "v2 refined", fields: ["id"] }],
      taskSeeds: [{ id: "t1", title: "one refined", description: "d2", files: [], dependsOn: [], acceptanceRefs: [], tags: [] }],
      constraints: ["c2", "c3"],
    }, false);
    expect(s.spec.entities.map((e) => e.name)).toEqual(["User", "Team"]);
    expect(s.spec.entities[0]!.description).toBe("v2 refined");
    expect(s.spec.taskSeeds).toHaveLength(1);
    expect(s.spec.taskSeeds[0]!.title).toBe("one refined");
    expect(s.spec.constraints).toEqual(["c1", "c2", "c3"]);
  });

  it("complete=true seals the section", () => {
    const s = recordContent(initialState("r", "t"), "scale-path", { scalePath: ["cache"] }, true);
    expect(s.spec.sections["scale-path"]).toBe("complete");
  });
});

describe("nextOpenSection / isComplete", () => {
  it("walks SPEC_SECTIONS in charter order", () => {
    let s = initialState("r", "t");
    expect(nextOpenSection(s)).toBe("api-spec");
    s = recordContent(s, "api-spec", {}, true);
    expect(nextOpenSection(s)).toBe("capability-expansion");
    expect(isComplete(s)).toBe(false);
  });

  it("isComplete only when every section is complete", () => {
    let s = initialState("r", "t");
    for (const section of SPEC_SECTIONS) s = recordContent(s, section, {}, true);
    expect(nextOpenSection(s)).toBeNull();
    expect(isComplete(s)).toBe(true);
    expect(() => specSchema.parse(s.spec)).not.toThrow();
  });
});

describe("sectionPayloadSchema", () => {
  it("accepts partial fragments and strips unknown keys (chatty models degrade softly)", () => {
    const parsed = sectionPayloadSchema.parse({ constraints: ["x"], banana: true });
    expect(parsed.constraints).toEqual(["x"]);
    expect("banana" in parsed).toBe(false);
    expect(parsed.entities).toBeUndefined(); // absent means "nothing to add", not reset
  });

  it("rejects wrong shapes so the loop can treat them as a failed turn", () => {
    expect(sectionPayloadSchema.safeParse({ entities: "not-an-array" }).success).toBe(false);
    expect(sectionPayloadSchema.safeParse({ taskSeeds: [{ id: "x" }] }).success).toBe(false); // missing title/description
  });
});
