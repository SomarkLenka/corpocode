// The prompt IS a contract: the loop Zod-parses exactly the three move shapes the interrogate
// prompt teaches, so a drifted prompt must fail here — not surface as mysterious failed turns.
import { describe, it, expect } from "vitest";
import {
  SUPERPOWERS_PROVENANCE,
  UM_INTERROGATE_V0,
  UM_DECOMPOSE_V0,
} from "../../../src/um/harvest/superpowers";
import { SPEC_SECTIONS } from "../../../src/um/types";

describe("SUPERPOWERS_PROVENANCE", () => {
  it("pins the upstream repo and a full commit SHA (or declares derived)", () => {
    expect(SUPERPOWERS_PROVENANCE.repo).toContain("obra/superpowers");
    if (SUPERPOWERS_PROVENANCE.derived) {
      // derived means fetching failed and the prompts were authored from the docs — no pin exists
      expect(SUPERPOWERS_PROVENANCE.commit).toBeNull();
    } else {
      expect(SUPERPOWERS_PROVENANCE.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(SUPERPOWERS_PROVENANCE.fetchedAt).toBeTruthy();
    }
  });
});

describe("UM_INTERROGATE_V0", () => {
  it("embeds all three move shapes of the interrogator protocol", () => {
    expect(UM_INTERROGATE_V0).toContain('{"move":"fork"');
    expect(UM_INTERROGATE_V0).toContain('{"move":"content"');
    expect(UM_INTERROGATE_V0).toContain('{"move":"done"}');
  });

  it("names every fork field the loop parses", () => {
    for (const field of ["fork", "id", "section", "concept", "question", "major", "suggested", "options", "label", "description"]) {
      expect(UM_INTERROGATE_V0).toContain(`"${field}"`);
    }
  });

  it("names every content-move field and every additive payload key", () => {
    for (const field of ["complete", "payload"]) {
      expect(UM_INTERROGATE_V0).toContain(`"${field}"`);
    }
    for (const key of ["entities", "contracts", "constraints", "futureSeams", "compartments", "scalePath", "reusableSystems", "acceptance", "taskSeeds"]) {
      expect(UM_INTERROGATE_V0).toContain(key);
    }
  });

  it("names all 7 charter section ids", () => {
    expect(SPEC_SECTIONS).toHaveLength(7);
    for (const section of SPEC_SECTIONS) {
      expect(UM_INTERROGATE_V0).toContain(section);
    }
  });

  it("carries all 4 substitution placeholders", () => {
    for (const placeholder of ["{{task}}", "{{remainingSections}}", "{{grounding}}", "{{lastAnswer}}"]) {
      expect(UM_INTERROGATE_V0).toContain(placeholder);
    }
  });

  it("demands exactly one JSON object per turn and 2-4 option forks with a suggestion", () => {
    expect(UM_INTERROGATE_V0).toContain("EXACTLY ONE JSON object");
    expect(UM_INTERROGATE_V0).toContain("2-4");
  });
});

describe("UM_DECOMPOSE_V0", () => {
  it("carries the {{spec}} placeholder", () => {
    expect(UM_DECOMPOSE_V0).toContain("{{spec}}");
  });

  it("teaches the taskSeeds output shape the decompose stage parses", () => {
    expect(UM_DECOMPOSE_V0).toContain('"taskSeeds"');
    for (const field of ["id", "title", "description", "files", "dependsOn", "verifyCommand", "acceptanceRefs"]) {
      expect(UM_DECOMPOSE_V0).toContain(`"${field}"`);
    }
  });

  it("keeps the writing-plans discipline: deterministic verify, no placeholders, exact paths", () => {
    expect(UM_DECOMPOSE_V0).toMatch(/DETERMINISTIC verifyCommand/);
    expect(UM_DECOMPOSE_V0).toContain("TBD");
    expect(UM_DECOMPOSE_V0).toContain("Exact file paths");
  });
});
