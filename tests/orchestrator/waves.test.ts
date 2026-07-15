import { describe, expect, it } from "vitest";
import { computeWaves } from "../../src/orchestrator/waves";

const t = (id: string, dependsOn: string[] = [], files: string[] = []) => ({ id, dependsOn, files });

describe("computeWaves", () => {
  it("layers a diamond into three waves", () => {
    const r = computeWaves([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])]);
    expect(r).toEqual({ ok: true, waves: [["a"], ["b", "c"], ["d"]] });
  });

  it("independent tasks share a wave", () => {
    const r = computeWaves([t("a", [], ["src/x/"]), t("b", [], ["src/y/"])]);
    expect(r).toEqual({ ok: true, waves: [["a", "b"]] });
  });

  it("serializes ready tasks whose files overlap (prefix collision)", () => {
    const r = computeWaves([t("a", [], ["src/ui/"]), t("b", [], ["src/ui/theme.ts"]), t("c", [], ["src/api/"])]);
    // b overlaps a (src/ui/ is a prefix of src/ui/theme.ts) → deferred to wave 2; c is disjoint.
    expect(r).toEqual({ ok: true, waves: [["a", "c"], ["b"]] });
  });

  it("treats windows and posix separators as the same path", () => {
    const r = computeWaves([t("a", [], ["src\\ui\\"]), t("b", [], ["src/ui/theme.ts"])]);
    expect(r).toEqual({ ok: true, waves: [["a"], ["b"]] });
  });

  it("reports a cycle instead of looping", () => {
    const r = computeWaves([t("a", ["b"]), t("b", ["a"])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cycle");
  });

  it("reports an unknown dependency", () => {
    const r = computeWaves([t("a", ["ghost"])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
  });
});
