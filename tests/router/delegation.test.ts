// Auto-delegation planner — proves the Phase 3 §5 matrix: suggest by default, escalate to an auto
// directive only when delegation is enabled, mode is "auto", AND the platform supports subagents.
import { describe, it, expect } from "vitest";
import { planDelegation } from "../../src/router/delegation";
import { configSchema } from "../../src/config/schema";

const base = configSchema.parse({});
const auto = configSchema.parse({ delegation: { mode: "auto" } });
const off = configSchema.parse({ delegation: { enabled: false } });

describe("planDelegation", () => {
  it("returns null when there is nothing to delegate", () => {
    expect(planDelegation(undefined, auto, "claude-code")).toBeNull();
  });

  it("returns null when delegation is disabled, even with a target", () => {
    expect(planDelegation("test-engineer", off, "claude-code")).toBeNull();
  });

  it("suggests (does not direct) in the default mode", () => {
    const d = planDelegation("test-engineer", base, "claude-code");
    expect(d).not.toBeNull();
    expect(d!.mode).toBe("suggest");
    expect(d!.text).toContain("Consider delegating");
    expect(d!.text).toContain("test-engineer");
  });

  it("escalates to an auto directive on a subagent-capable platform", () => {
    const d = planDelegation("test-engineer", auto, "claude-code");
    expect(d!.mode).toBe("auto");
    expect(d!.text).toContain("Delegate it");
  });

  it("falls back to suggest in auto mode on a platform without subagents", () => {
    const d = planDelegation("test-engineer", auto, "gemini-cli");
    expect(d!.mode).toBe("suggest"); // graceful degradation: can't direct what the platform can't do
  });
});
