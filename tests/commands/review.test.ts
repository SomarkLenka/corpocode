// `corpocode review` analyzer — proves it turns the log into actionable, advisory-only proposals:
// noisy tenets (many low-confidence fires), idle tenets (active but never fired), and router pressure.
// Pure function over canned NDJSON lines; no log file or filesystem needed.
import { describe, it, expect } from "vitest";
import { computeReview } from "../../src/commands/review";
import { configSchema } from "../../src/config/schema";

const config = configSchema.parse({});

function line(rec: Record<string, unknown>): string {
  return JSON.stringify({ ts: "2026-05-30T00:00:00.000Z", ...rec });
}

const NOW = Date.parse("2026-05-31T00:00:00.000Z");

describe("computeReview", () => {
  it("flags a tenet that fires often with low confidence as noise", () => {
    const lines = Array.from({ length: 6 }, () =>
      line({ event: "verifier_check", tenet: "A", verdict: "violation", confidence: 0.2 }),
    );
    const report = computeReview(lines, { now: NOW, days: 7 });
    const noise = report.proposals.find((p) => p.kind === "tenet_noise");
    expect(noise).toBeDefined();
    expect(noise!.evidence.tenet).toBe("A");
    expect(noise!.evidence.fires).toBe(6);
    expect(noise!.suggestion).toContain("molar_edit.strictness.A");
    // PR-ready: a concrete, machine-applicable patch the user can open as a diff (never auto-applied).
    expect(noise!.patch).toEqual({ path: "molar_edit.strictness.A", op: "set", value: "off" });
  });

  it("does not flag noise below the minimum-fires threshold", () => {
    const lines = [line({ event: "verifier_check", tenet: "A", verdict: "violation", confidence: 0.1 })];
    const report = computeReview(lines, { now: NOW, days: 7 });
    expect(report.proposals.some((p) => p.kind === "tenet_noise")).toBe(false);
  });

  it("flags an active tenet that never fired as idle (only when there was verifier activity)", () => {
    // O fires with healthy confidence; the other active tenets never fire → idle proposals for them.
    const lines = Array.from({ length: 5 }, () =>
      line({ event: "verifier_check", tenet: "O", verdict: "ok", confidence: 0.9 }),
    );
    const report = computeReview(lines, { now: NOW, days: 7, config });
    const idle = report.proposals.filter((p) => p.kind === "tenet_idle").map((p) => p.evidence.tenet);
    expect(idle).toContain("M"); // active by default, never fired
    expect(idle).not.toContain("O"); // it did fire
  });

  it("flags router pressure when every turn escalates to stage 2", () => {
    const lines = Array.from({ length: 5 }, () => line({ event: "router", stage2_invoked: true }));
    const report = computeReview(lines, { now: NOW, days: 7, config });
    expect(report.turns).toBe(5);
    expect(report.proposals.some((p) => p.kind === "router_pressure")).toBe(true);
  });

  it("honors the time window and emits no proposals on a clean log", () => {
    const stale = line({ ts: "2020-01-01T00:00:00.000Z", event: "verifier_check", tenet: "A", confidence: 0.1 });
    const report = computeReview([stale], { now: NOW, days: 7, config });
    expect(report.verifierChecks).toBe(0); // outside the window
    expect(report.proposals).toEqual([]);
  });
});
