import { describe, expect, it } from "vitest";
import { checkSpecCompleteness } from "../../src/um/completeness";
import type { Spec } from "../../src/um/spec-schema";

/** Minimal complete spec; individual tests break one thing at a time. */
function completeSpec(): Spec {
  return {
    version: 1,
    runId: "run-x",
    task: "add dark mode",
    entities: [],
    contracts: [],
    constraints: ["no new runtime deps"],
    futureSeams: [],
    compartments: [],
    scalePath: [],
    reusableSystems: [],
    acceptance: [
      {
        id: "ac1",
        criterion: "WHEN the toggle is clicked THE SYSTEM SHALL persist the theme to localStorage",
        verify: { method: "command", command: "npx vitest run tests/theme" },
      },
    ],
    taskSeeds: [
      {
        id: "t1",
        title: "theme toggle",
        description: "build the toggle component",
        files: ["src/ui/"],
        dependsOn: [],
        verifyCommand: "npx vitest run tests/theme",
        acceptanceRefs: ["ac1"],
      },
    ],
    decisions: [],
    sections: {
      "api-spec": "complete",
      "capability-expansion": "complete",
      "future-plans": "complete",
      parallelization: "complete",
      compartmentalization: "complete",
      "scale-path": "complete",
      "reusable-systems": "complete",
    },
  } as Spec;
}

describe("checkSpecCompleteness", () => {
  it("passes a complete spec", () => {
    expect(checkSpecCompleteness(completeSpec())).toEqual({ ok: true, failures: [] });
  });

  it("fails on an unresolved [NEEDS CLARIFICATION] marker", () => {
    const spec = completeSpec();
    spec.taskSeeds[0]!.description = "build it [NEEDS CLARIFICATION: which store?]";
    const r = checkSpecCompleteness(spec);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("NEEDS CLARIFICATION");
  });

  it("fails a non-EARS acceptance criterion", () => {
    const spec = completeSpec();
    spec.acceptance[0]!.criterion = "the toggle should work well";
    const r = checkSpecCompleteness(spec);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("not EARS-shaped");
  });

  it("fails a command-verified criterion with no command", () => {
    const spec = completeSpec();
    spec.acceptance[0]!.verify = { method: "command" };
    expect(checkSpecCompleteness(spec).ok).toBe(false);
  });

  it("fails a task seed with no or unknown acceptance refs", () => {
    const spec = completeSpec();
    spec.taskSeeds[0]!.acceptanceRefs = ["nope"];
    const r = checkSpecCompleteness(spec);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('unknown acceptance ref "nope"');
  });

  it("fails while any section is not complete", () => {
    const spec = completeSpec();
    spec.sections["scale-path"] = "open";
    expect(checkSpecCompleteness(spec).ok).toBe(false);
  });
});
