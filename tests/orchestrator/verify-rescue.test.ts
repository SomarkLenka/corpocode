import { describe, expect, it } from "vitest";
import { verifyAndRescue } from "../../src/orchestrator/verify-rescue";
import type { VerifyRescueDeps } from "../../src/orchestrator/verify-rescue";
import type { ArbitrateResult } from "../../src/orchestrator/arbiter";
import type { ArbiterVerdict } from "../../src/orchestrator/verdict";

function verdict(decision: ArbiterVerdict["decision"], specGaps: string[] = []): ArbiterVerdict {
  return { decision, criteria: [{ id: "ac1", met: decision === "accept", note: "n" }], summary: `s:${decision}`, specGaps };
}
const okResult = (v: ArbiterVerdict): ArbitrateResult => ({ ok: true, verdict: v, costUsd: 0.01 });
const deadResult = (): ArbitrateResult => ({ ok: false, skipped: "claude not found", costUsd: 0 });

/** Deps builder — every model/verify/author step is a plain async stub. NO real model, ever. */
function deps(over: Partial<VerifyRescueDeps>): VerifyRescueDeps {
  return {
    arbitrate: async () => okResult(verdict("accept")),
    reArbitrate: async () => okResult(verdict("accept")),
    rescueAuthor: async () => true,
    mode: "verify-rescue",
    maxRedispatch: 2,
    ...over,
  };
}

describe("verifyAndRescue", () => {
  it("accept on the first pass → accepted, 0 rescues", async () => {
    const res = await verifyAndRescue(deps({ arbitrate: async () => okResult(verdict("accept")) }));
    expect(res.outcome).toBe("accepted");
    expect(res.rescues).toBe(0);
    expect(res.verdict?.decision).toBe("accept");
  });

  it("spec-gap → escalate-spec-gap in gate mode (spec holes always route to the human)", async () => {
    const res = await verifyAndRescue(deps({ mode: "gate", arbitrate: async () => okResult(verdict("spec-gap", ["hole"])) }));
    expect(res.outcome).toBe("escalate-spec-gap");
    expect(res.rescues).toBe(0);
  });

  it("spec-gap → escalate-spec-gap in verify-rescue mode too", async () => {
    const res = await verifyAndRescue(deps({ mode: "verify-rescue", arbitrate: async () => okResult(verdict("spec-gap", ["hole"])) }));
    expect(res.outcome).toBe("escalate-spec-gap");
  });

  it("reject in gate mode → rejected, 0 rescues, no rescue attempted", async () => {
    let authored = 0;
    const res = await verifyAndRescue(
      deps({ mode: "gate", arbitrate: async () => okResult(verdict("reject")), rescueAuthor: async () => (authored++, true) }),
    );
    expect(res.outcome).toBe("rejected");
    expect(res.rescues).toBe(0);
    expect(authored).toBe(0);
  });

  it("reject then reArbitrate accepts on the first rescue → rescued-accepted, 1 rescue", async () => {
    const res = await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        arbitrate: async () => okResult(verdict("reject")),
        reArbitrate: async () => okResult(verdict("accept")),
      }),
    );
    expect(res.outcome).toBe("rescued-accepted");
    expect(res.rescues).toBe(1);
    expect(res.verdict?.decision).toBe("accept");
  });

  it("reject that never accepts, maxRedispatch=2 → rejected with rescues=2", async () => {
    let calls = 0;
    const res = await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        maxRedispatch: 2,
        arbitrate: async () => okResult(verdict("reject")),
        reArbitrate: async () => (calls++, okResult(verdict("reject"))),
      }),
    );
    expect(res.outcome).toBe("rejected");
    expect(res.rescues).toBe(2);
    expect(calls).toBe(2);
  });

  it("rescueAuthor produces no change → stop rescuing, rejected with the rescues so far", async () => {
    const res = await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        maxRedispatch: 3,
        arbitrate: async () => okResult(verdict("reject")),
        rescueAuthor: async () => false, // cheap agent produced nothing
      }),
    );
    expect(res.outcome).toBe("rejected");
    expect(res.rescues).toBe(0);
  });

  it("dead arbiter on the first pass → escalate (never auto-accepts)", async () => {
    const res = await verifyAndRescue(deps({ arbitrate: async () => deadResult() }));
    expect(res.outcome).toBe("escalate");
    expect(res.escalation).toContain("claude not found");
    expect(res.verdict).toBeUndefined();
  });

  it("dead arbiter DURING rescue re-judgement → escalate", async () => {
    const res = await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        arbitrate: async () => okResult(verdict("reject")),
        reArbitrate: async () => deadResult(),
      }),
    );
    expect(res.outcome).toBe("escalate");
    expect(res.escalation).toContain("claude not found");
  });

  it("reArbitrate surfaces a spec-gap during rescue → escalate-spec-gap", async () => {
    const res = await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        arbitrate: async () => okResult(verdict("reject")),
        reArbitrate: async () => okResult(verdict("spec-gap", ["hole surfaced mid-rescue"])),
      }),
    );
    expect(res.outcome).toBe("escalate-spec-gap");
    expect(res.rescues).toBe(1);
  });

  it("passes the arbiter summary + criteria notes to the cheap rescue author (arbiter authors nothing)", async () => {
    let seenProse = "";
    await verifyAndRescue(
      deps({
        mode: "verify-rescue",
        maxRedispatch: 1,
        arbitrate: async () => okResult(verdict("reject")),
        rescueAuthor: async (prose) => {
          seenProse = prose;
          return false;
        },
      }),
    );
    expect(seenProse).toContain("s:reject"); // the verdict summary
    expect(seenProse).toContain("ac1"); // a criterion note is threaded in
  });
});
