import { describe, expect, it } from "vitest";
import { UM_INTERROGATE_V0 } from "../../src/um/harvest/superpowers";

describe("interrogate charter — Phase 2 authoring rules", () => {
  it("instructs EARS-shaped acceptance criteria", () => {
    expect(UM_INTERROGATE_V0).toContain("WHEN");
    expect(UM_INTERROGATE_V0).toContain("SHALL");
    expect(UM_INTERROGATE_V0).toMatch(/EARS/);
  });

  it("instructs fork-instead-of-guess with the clarification marker as last resort", () => {
    expect(UM_INTERROGATE_V0).toContain("[NEEDS CLARIFICATION");
  });
});
