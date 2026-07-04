import { describe, it, expect } from "vitest";
import { explain, describe as describeEvent, labelFor } from "../../src/log/explain";

// The shared event→prose table behind both `corpocode why` and the monitor's live Events feed.
// why.test.ts exercises the whole table through computeWhy; here we pin the small `explain()` seam
// the monitor consumes per-record (label + text, or null for untranslatable events).

describe("explain · per-record narration", () => {
  it("narrates a translatable event with its label and prose", () => {
    const r = explain({ event: "filter", component: "filter", decision: "deny", tool: "Bash", reason: "rm -rf" });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("filter");
    expect(r!.text).toContain("Denied");
    expect(r!.text).toContain("`Bash`");
  });

  it("labels a pattern event by its pattern, not its component", () => {
    const r = explain({ event: "pattern", pattern: "pre-write", component: "router", decision: "skipped", reason: "gate:no-blast-radius" });
    expect(r!.label).toBe("pre-write");
    expect(r!.text).toBe("Skipped (gate:no-blast-radius).");
  });

  it("labels an inject event `injector`, separating it from the filter story", () => {
    expect(labelFor({ event: "inject", component: "filter", file: "a.ts", sliced: true })).toBe("injector");
  });

  it("returns null for an event with no translation", () => {
    expect(explain({ event: "heartbeat" })).toBeNull();
    expect(describeEvent({ event: "heartbeat" })).toBeNull();
  });

  it("returns null for a malformed row (no event field)", () => {
    expect(explain({ raw: "{oops" })).toBeNull();
  });
});
