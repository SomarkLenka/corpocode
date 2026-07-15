import { describe, it, expect, vi } from "vitest";
import {
  resolveSoftPreAsk,
  resolveOnTimeout,
  softAsk,
  type SoftDecision,
} from "../../src/um/soft-poll";
import type { Answer, Poll } from "../../src/interact/types";

// ---------- fixtures ----------

function makePoll(over?: Partial<Poll>): Poll {
  return {
    id: "p1",
    concept: "persistence",
    question: "SQLite or JSON?",
    options: [
      { id: "a", label: "A", findings: [] },
      { id: "b", label: "B", findings: [] },
    ],
    allowFreeText: true,
    allowDelegate: true,
    ...over,
  };
}

/** A promise we can resolve on demand — makes the race deterministic without real timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------- resolveSoftPreAsk (pure) ----------

describe("resolveSoftPreAsk", () => {
  it("assume + defaultOptionId → auto-confidence resolving the default without asking", () => {
    const poll = makePoll({ defaultOptionId: "a" });
    const d = resolveSoftPreAsk(poll, "assume");
    expect(d).toEqual<SoftDecision>({
      action: "auto-confidence",
      answer: { pollId: "p1", optionId: "a", source: "default" },
    });
  });

  it("assume WITHOUT a default → still ask (nothing confident to auto-resolve to)", () => {
    const poll = makePoll();
    expect(resolveSoftPreAsk(poll, "assume")).toEqual<SoftDecision>({ action: "ask" });
  });

  it("poll treatment → ask, even with a default present", () => {
    const poll = makePoll({ defaultOptionId: "a" });
    expect(resolveSoftPreAsk(poll, "poll")).toEqual<SoftDecision>({ action: "ask" });
  });

  it("teach-then-poll treatment → ask", () => {
    const poll = makePoll({ defaultOptionId: "a" });
    expect(resolveSoftPreAsk(poll, "teach-then-poll")).toEqual<SoftDecision>({ action: "ask" });
  });
});

// ---------- resolveOnTimeout (pure) ----------

describe("resolveOnTimeout", () => {
  it("with a default → auto-timeout resolving the default", () => {
    const poll = makePoll({ defaultOptionId: "b" });
    expect(resolveOnTimeout(poll)).toEqual<SoftDecision>({
      action: "auto-timeout",
      answer: { pollId: "p1", optionId: "b", source: "default" },
    });
  });

  it("with NO default → pause (a contested fork must not be coin-flipped unwatched)", () => {
    const poll = makePoll();
    expect(resolveOnTimeout(poll)).toEqual<SoftDecision>({ action: "pause" });
  });
});

// ---------- softAsk (orchestration) ----------

describe("softAsk", () => {
  it("assume + default → auto-confidence and NEVER calls ask()", async () => {
    const poll = makePoll({ defaultOptionId: "a" });
    const ask = vi.fn(async (): Promise<Answer | null> => ({ pollId: "p1", optionId: "b", source: "pilot" }));
    const awaitTimeout = vi.fn(async (): Promise<"timeout"> => "timeout");

    const res = await softAsk({ poll, treatment: "assume", ask, awaitTimeout });

    expect(res).toEqual({ answer: { pollId: "p1", optionId: "a", source: "default" }, via: "auto-confidence" });
    expect(ask).not.toHaveBeenCalled();
    expect(awaitTimeout).not.toHaveBeenCalled();
  });

  it("poll treatment: ask wins the race when it resolves first → via 'ask'", async () => {
    const poll = makePoll({ defaultOptionId: "a" });
    const answer: Answer = { pollId: "p1", optionId: "b", source: "pilot" };
    const timeout = deferred<"timeout">(); // never resolves
    const ask = async (): Promise<Answer | null> => answer;

    const res = await softAsk({ poll, treatment: "poll", ask, awaitTimeout: () => timeout.promise });

    expect(res).toEqual({ answer, via: "ask" });
  });

  it("timeout wins + default present → auto-timeout resolving the default", async () => {
    const poll = makePoll({ defaultOptionId: "a" });
    const pending = deferred<Answer | null>(); // ask never resolves
    const ask = (): Promise<Answer | null> => pending.promise;
    const awaitTimeout = async (): Promise<"timeout"> => "timeout";

    const res = await softAsk({ poll, treatment: "poll", ask, awaitTimeout });

    expect(res).toEqual({ answer: { pollId: "p1", optionId: "a", source: "default" }, via: "auto-timeout" });
  });

  it("timeout wins + NO default → pause with a null answer", async () => {
    const poll = makePoll(); // no default
    const pending = deferred<Answer | null>();
    const ask = (): Promise<Answer | null> => pending.promise;
    const awaitTimeout = async (): Promise<"timeout"> => "timeout";

    const res = await softAsk({ poll, treatment: "poll", ask, awaitTimeout });

    expect(res).toEqual({ answer: null, via: "pause" });
  });

  it("logs the resolution path when a log sink is provided", async () => {
    const poll = makePoll({ defaultOptionId: "a" });
    const logs: Record<string, unknown>[] = [];
    await softAsk({
      poll,
      treatment: "assume",
      ask: async () => null,
      awaitTimeout: async () => "timeout",
      log: (f) => logs.push(f),
    });
    expect(logs.some((l) => l.via === "auto-confidence")).toBe(true);
  });
});
