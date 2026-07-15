import { describe, expect, it, vi } from "vitest";
import { landingPoll, proposeLanding } from "../../src/orchestrator/landing";
import type { Interactor, Answer, Poll } from "../../src/interact/types";

function fakeInteractor(answer: Answer | null): Interactor {
  return {
    ask: async (_poll: Poll) => answer,
    say: () => {},
    close: async () => {},
  };
}

describe("landingPoll", () => {
  it("builds a keep/land poll with keep as the safe recommended default", () => {
    const poll = landingPoll("run-1", "corpocode/run-1/integration", "main");
    expect(poll.concept).toBe("landing");
    expect(poll.allowFreeText).toBe(false);
    expect(poll.allowDelegate).toBe(false);
    expect(poll.defaultOptionId).toBe("keep");
    expect(poll.options).toHaveLength(2);

    const keep = poll.options.find((o) => o.id === "keep");
    const land = poll.options.find((o) => o.id === "land");
    expect(keep).toBeDefined();
    expect(land).toBeDefined();
    expect(keep!.recommended).toBe(true);
    expect(land!.recommended).not.toBe(true);
    expect(land!.label).toContain("main");
    // The question names both branches so the pilot knows exactly what lands where.
    expect(poll.question).toContain("main");
    expect(poll.question).toContain("corpocode/run-1/integration");
  });
});

describe("proposeLanding", () => {
  const base = {
    runId: "run-1",
    integrationBranch: "corpocode/run-1/integration",
    userBranch: "main",
  };

  it("lands and calls land() exactly once when the pilot chooses 'land'", async () => {
    const land = vi.fn(async () => {});
    const res = await proposeLanding({
      ...base,
      interactor: fakeInteractor({ pollId: "landing", optionId: "land", source: "pilot" }),
      land,
    });
    expect(res.decision).toBe("landed");
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("declines and does NOT land when the pilot chooses 'keep'", async () => {
    const land = vi.fn(async () => {});
    const res = await proposeLanding({
      ...base,
      interactor: fakeInteractor({ pollId: "landing", optionId: "keep", source: "pilot" }),
      land,
    });
    expect(res.decision).toBe("declined");
    expect(res.reason).toBe("keep");
    expect(land).not.toHaveBeenCalled();
  });

  it("declines on freeText (any non-'land' answer) and does NOT land", async () => {
    const land = vi.fn(async () => {});
    const res = await proposeLanding({
      ...base,
      interactor: fakeInteractor({ pollId: "landing", freeText: "not yet", source: "pilot" }),
      land,
    });
    expect(res.decision).toBe("declined");
    expect(res.reason).toBe("not yet");
    expect(land).not.toHaveBeenCalled();
  });

  it("pauses and does NOT land when the answer is null", async () => {
    const land = vi.fn(async () => {});
    const res = await proposeLanding({
      ...base,
      interactor: fakeInteractor(null),
      land,
    });
    expect(res.decision).toBe("paused");
    expect(land).not.toHaveBeenCalled();
  });

  it("logs the decision", async () => {
    const log = vi.fn();
    await proposeLanding({
      ...base,
      interactor: fakeInteractor({ pollId: "landing", optionId: "land", source: "pilot" }),
      land: async () => {},
      log,
    });
    expect(log).toHaveBeenCalled();
  });
});
