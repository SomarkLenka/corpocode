import { describe, expect, it } from "vitest";
import { buildRubric, normalizeVerdict, VERDICT_SCHEMA } from "../../src/orchestrator/verdict";
import type { ArbiterVerdict } from "../../src/orchestrator/verdict";
import type { Spec } from "../../src/um/spec-schema";

/** A minimal spec fixture carrying just the acceptance array the rubric reads. */
function specWith(acceptance: Spec["acceptance"]): Spec {
  return {
    version: 1,
    runId: "r1",
    task: "t",
    entities: [],
    contracts: [],
    constraints: [],
    futureSeams: [],
    compartments: [],
    scalePath: [],
    reusableSystems: [],
    acceptance,
    taskSeeds: [],
    decisions: [],
    sections: {},
  };
}

const acceptance: Spec["acceptance"] = [
  { id: "ac1", criterion: "WHEN a THE SYSTEM SHALL b", verify: { method: "command", command: "npm test" } },
  { id: "ac2", criterion: "WHEN c THE SYSTEM SHALL d", verify: { method: "manual" } },
  { id: "ac3", criterion: "WHEN e THE SYSTEM SHALL f", verify: { method: "test", command: "vitest" } },
];

describe("buildRubric", () => {
  it("filters acceptance to the referenced ids, preserving criterion text", () => {
    const rubric = buildRubric(specWith(acceptance), ["ac1", "ac3"]);
    expect(rubric.criteria).toEqual([
      { id: "ac1", criterion: "WHEN a THE SYSTEM SHALL b" },
      { id: "ac3", criterion: "WHEN e THE SYSTEM SHALL f" },
    ]);
  });

  it("prose is each criterion as `- [id] criterion` joined by newlines", () => {
    const rubric = buildRubric(specWith(acceptance), ["ac1", "ac3"]);
    expect(rubric.prose).toBe("- [ac1] WHEN a THE SYSTEM SHALL b\n- [ac3] WHEN e THE SYSTEM SHALL f");
  });

  it("never invents criteria: unknown refs are dropped, order follows the spec", () => {
    const rubric = buildRubric(specWith(acceptance), ["ac3", "nope", "ac1"]);
    expect(rubric.criteria.map((c) => c.id)).toEqual(["ac1", "ac3"]);
  });

  it("emits a reject-unless-trivial sentinel when no criteria match", () => {
    const rubric = buildRubric(specWith(acceptance), ["nope"]);
    expect(rubric.criteria).toEqual([]);
    expect(rubric.prose).toContain("no acceptance criteria");
    expect(rubric.prose).toContain("reject unless trivially correct");
  });

  it("empty refs also yields the sentinel", () => {
    const rubric = buildRubric(specWith(acceptance), []);
    expect(rubric.criteria).toEqual([]);
    expect(rubric.prose).toContain("no acceptance criteria");
  });
});

describe("normalizeVerdict", () => {
  it("defaults missing specGaps to []", () => {
    const raw = { decision: "accept", criteria: [], summary: "ok" } as unknown as ArbiterVerdict;
    expect(normalizeVerdict(raw).specGaps).toEqual([]);
  });

  it("coerces decision to spec-gap when specGaps are non-empty and decision is not reject", () => {
    const raw: ArbiterVerdict = { decision: "accept", criteria: [], summary: "s", specGaps: ["the spec never says X"] };
    expect(normalizeVerdict(raw).decision).toBe("spec-gap");
  });

  it("leaves a reject decision untouched even with specGaps present", () => {
    const raw: ArbiterVerdict = { decision: "reject", criteria: [], summary: "s", specGaps: ["hole"] };
    const out = normalizeVerdict(raw);
    expect(out.decision).toBe("reject");
    expect(out.specGaps).toEqual(["hole"]);
  });

  it("leaves an accept decision untouched when there are no specGaps", () => {
    const raw: ArbiterVerdict = { decision: "accept", criteria: [{ id: "ac1", met: true, note: "" }], summary: "s", specGaps: [] };
    expect(normalizeVerdict(raw).decision).toBe("accept");
  });
});

describe("VERDICT_SCHEMA", () => {
  it("requires decision, criteria, and summary", () => {
    expect(VERDICT_SCHEMA.required).toEqual(expect.arrayContaining(["decision", "criteria", "summary"]));
  });

  it("constrains decision to the three verdicts and makes specGaps optional", () => {
    expect(VERDICT_SCHEMA.properties.decision.enum).toEqual(["accept", "reject", "spec-gap"]);
    expect(VERDICT_SCHEMA.properties.specGaps).toBeDefined();
    expect(VERDICT_SCHEMA.required).not.toContain("specGaps");
  });
});
