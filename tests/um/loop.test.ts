import { describe, it, expect } from "vitest";
import { runCockpit, type CockpitDeps, type CockpitPrompts } from "../../src/um/loop";
import { SPEC_SECTIONS } from "../../src/um/types";
import type { MasteryModel, MasteryOutcome, MasteryTreatment } from "../../src/um/types";
import { specSchema } from "../../src/um/spec-schema";
import type { AgentBackend, AgentCall, AgentResult } from "../../src/agents/backend";
import type { Answer, Interactor, Poll } from "../../src/interact/types";
import type { CorpoConfig } from "../../src/config/schema";

// ---------- fakes: everything injected, no fs, no processes, no real models ----------

/** Interrogate backend fed a queue of canned moves (objects stringified, strings passed raw). */
function scriptedInterrogate(script: unknown[]): { backend: AgentBackend; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const invoke = async (call: AgentCall): Promise<AgentResult> => {
    calls.push(call);
    const item = script.shift();
    const text = typeof item === "string" ? item : JSON.stringify(item ?? {});
    return {
      ok: true,
      text,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002, latencyMs: 3, model: "cheap" },
      model: { providerKey: "default", model: "cheap" },
      session: { id: "sess-1", persisted: true },
    };
  };
  return {
    backend: { id: "anthropic-cli", invoke: invoke as AgentBackend["invoke"], release: async () => {}, health: async () => ({ up: true }), ping: async () => true, shutdown: async () => {} },
    calls,
  };
}

/** Consequence backend: derives severity from the rendered prompt (`${axis}::${optionLabel}`). */
function fakeConsequence(riskyTask = "perf::B"): { backend: AgentBackend; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const invoke = async (call: AgentCall): Promise<AgentResult> => {
    calls.push(call);
    return {
      ok: true,
      data: { summary: `analysis of ${call.task}`, severity: call.task === riskyTask ? "risk" : "info" },
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.001, latencyMs: 2, model: "cheap" },
      model: { providerKey: "default", model: "cheap" },
    };
  };
  return {
    backend: { id: "anthropic-cli", invoke: invoke as AgentBackend["invoke"], release: async () => {}, health: async () => ({ up: true }), ping: async () => true, shutdown: async () => {} },
    calls,
  };
}

function fakeInteractor(answers: ((poll: Poll) => Answer | null)[]): { interactor: Interactor; polls: Poll[] } {
  const polls: Poll[] = [];
  return {
    polls,
    interactor: {
      ask: async (poll) => {
        polls.push(poll);
        const next = answers.shift();
        return next ? next(poll) : null; // exhausted answers = a dead channel
      },
      say: () => {},
      close: async () => {},
    },
  };
}

function fakeMastery(treatment: MasteryTreatment = "teach-then-poll"): {
  model: MasteryModel;
  observed: { concept: string; outcome: MasteryOutcome }[];
} {
  const observed: { concept: string; outcome: MasteryOutcome }[] = [];
  return { observed, model: { treatment: () => treatment, observe: (concept, outcome) => observed.push({ concept, outcome }) } };
}

function fakeBudget(exceedQueue: boolean[] = []): { budget: CockpitDeps["budget"]; charges: number[] } {
  const charges: number[] = [];
  return {
    charges,
    budget: {
      wouldExceed: () => exceedQueue.shift() ?? false,
      charge: (_phase, usd) => charges.push(usd),
    },
  };
}

const prompts: CockpitPrompts = {
  interrogate: (vars) => `interrogate|${vars.remainingSections.join(",")}|${vars.lastAnswer ?? ""}`,
  axis: (axis, vars) => `${axis}::${vars.optionLabel}`,
};

function orchestration(over?: {
  granularity?: "every-fork" | "major-forks" | "minimal";
  max_polls?: number;
  teach?: boolean;
}): CorpoConfig["orchestrator"] {
  return {
    enabled: true,
    initialized: true,
    interrogation: {
      interface: "terminal",
      granularity: over?.granularity ?? "every-fork",
      consequence_axes: ["perf", "maint"],
      fanout_width: 2,
      max_polls: over?.max_polls ?? 40,
      teach: over?.teach ?? true,
      mastery: { enabled: false, alpha: 0.15, theta_teach: 0.4, theta_assume: 0.8, debounce_k: 3 },
    },
    roles: {
      interrogate: { effort: "medium", timeout_ms: 60_000 },
      consequence: { effort: "minimal", timeout_ms: 30_000 },
    },
    swarm: { max_parallel_writers: 3, worktrees: true },
    verify: { cadence: "per-wave", mode: "gate", max_redispatch: 2, rescue_max_output_tokens: 800 },
    budget: { max_run_usd: null, spec_usd: null, verify_usd: null, build_usd: null },
    runs_ttl_days: 14,
  };
}

// ---------- canned moves ----------

const contentMove = (section: string, complete = true, payload: Record<string, unknown> = {}) => ({
  move: "content",
  section,
  complete,
  payload,
});
const allSectionsContent = SPEC_SECTIONS.map((s, i) =>
  i === 0 ? contentMove(s, true, { entities: [{ name: "User", description: "d" }], constraints: ["node>=20"] }) : contentMove(s),
);
const forkMove = (id = "f1", major = true, suggested = "b") => ({
  move: "fork",
  fork: {
    id,
    section: "api-spec",
    concept: "persistence",
    question: "SQLite or JSON?",
    major,
    suggested,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  },
});
const DONE = { move: "done" };

function makeDeps(
  script: unknown[],
  over?: Partial<CockpitDeps> & { answers?: ((poll: Poll) => Answer | null)[] },
): { deps: CockpitDeps; interrogateCalls: AgentCall[]; consequenceCalls: AgentCall[]; polls: Poll[]; observed: ReturnType<typeof fakeMastery>["observed"]; charges: number[] } {
  const interro = scriptedInterrogate(script);
  const conseq = fakeConsequence();
  const { interactor, polls } = fakeInteractor(over?.answers ?? []);
  const mastery = fakeMastery();
  const { budget, charges } = fakeBudget();
  let t = 1000;
  const deps: CockpitDeps = {
    forTask: (kind) => (kind === "interrogate" ? interro.backend : conseq.backend),
    interactor,
    mastery: mastery.model,
    prompts,
    orchestration: orchestration(),
    runId: "run-1",
    task: "build a widget service",
    budget,
    now: () => ++t,
    ...over,
  };
  return { deps, interrogateCalls: interro.calls, consequenceCalls: conseq.calls, polls, observed: mastery.observed, charges };
}

const pilotPicks = (optionId: string) => (poll: Poll): Answer => ({ pollId: poll.id, optionId, source: "pilot" });

// ---------- tests ----------

describe("runCockpit — approval path", () => {
  it("interrogates to a complete, approved, schema-valid spec with a fully attributed ledger", async () => {
    const logs: Record<string, unknown>[] = [];
    const { deps, interrogateCalls, consequenceCalls, polls, observed, charges } = makeDeps(
      [...allSectionsContent, forkMove(), DONE],
      { answers: [pilotPicks("a"), pilotPicks("approve")], log: (l) => logs.push(l) },
    );
    const outcome = await runCockpit(deps);

    expect(outcome.status).toBe("approved");
    expect(outcome.state.spec.approvedAt).toBeGreaterThan(1000);
    // round-trips through the authoritative schema
    expect(specSchema.parse(outcome.state.spec)).toEqual(outcome.state.spec);
    expect(outcome.state.spec.entities.map((e) => e.name)).toEqual(["User"]);
    for (const s of SPEC_SECTIONS) expect(outcome.state.spec.sections[s]).toBe("complete");

    // the ledger carries the fork, the pilot's source, and the computed findings
    const ledger = outcome.state.spec.decisions;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.answer).toEqual({ pollId: "f1", optionId: "a", source: "pilot" });
    expect(ledger[0]!.options.map((o) => o.findings.length)).toEqual([2, 2]);
    expect(ledger[0]!.options[0]!.findings[0]!.ok).toBe(true);

    // fan-out ran option x axis; the poll carried teaching + the majority recommendation
    expect(consequenceCalls).toHaveLength(4);
    expect(polls[0]!.teaching?.concept).toBe("persistence");
    expect(polls[0]!.defaultOptionId).toBe("a"); // B was risky on perf, maint tied ⇒ A wins
    expect(polls[1]!.id).toBe("approve-spec");
    expect(polls[1]!.allowDelegate).toBe(false);
    expect(polls[1]!.defaultOptionId).toBeUndefined();

    // persistent interrogate session: persist first, then reuse the returned id
    expect(interrogateCalls[0]!.session).toEqual({ persist: true });
    for (const call of interrogateCalls.slice(1)) expect(call.session).toEqual({ reuse: "sess-1" });

    expect(observed).toEqual([{ concept: "persistence", outcome: { confident: true, delegated: false } }]);
    // 9 interrogate turns + 1 fan-out charge, all against the spec phase
    expect(charges).toHaveLength(10);
    expect(logs.some((l) => l.event === "cockpit_approved")).toBe(true);
  });

  it("autoApprove skips the approve poll and records a --yes pilot answer path", async () => {
    const { deps, polls } = makeDeps([...allSectionsContent, DONE], { autoApprove: true });
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    expect(outcome.state.spec.approvedAt).toBeDefined();
    expect(polls).toHaveLength(0); // no human needed
  });
});

describe("runCockpit — granularity dial", () => {
  it("major-forks: a non-major fork auto-resolves to the suggestion, ledgered as delegated with no findings", async () => {
    const { deps, polls, consequenceCalls, observed } = makeDeps(
      [forkMove("f-minor", false, "b"), ...allSectionsContent, DONE],
      { orchestration: orchestration({ granularity: "major-forks" }), autoApprove: true },
    );
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    const d = outcome.state.spec.decisions[0]!;
    expect(d.answer).toEqual({ pollId: "f-minor", optionId: "b", source: "delegated" });
    expect(d.options.every((o) => o.findings.length === 0)).toBe(true);
    expect(polls).toHaveLength(0);
    expect(consequenceCalls).toHaveLength(0); // no fan-out for an unasked fork
    expect(observed).toHaveLength(0); // auto-resolution says nothing about the pilot
  });

  it("major-forks: a major fork IS asked", async () => {
    const { deps, polls } = makeDeps([forkMove("f-major", true), ...allSectionsContent, DONE], {
      orchestration: orchestration({ granularity: "major-forks" }),
      answers: [pilotPicks("a")],
      autoApprove: true,
    });
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    expect(polls.map((p) => p.id)).toEqual(["f-major"]);
    expect(outcome.state.spec.decisions[0]!.answer.source).toBe("pilot");
  });

  it("minimal: even major forks auto-resolve; only the approve poll is ever asked", async () => {
    const { deps, polls } = makeDeps([forkMove("f1", true, "a"), ...allSectionsContent, DONE], {
      orchestration: orchestration({ granularity: "minimal" }),
      answers: [pilotPicks("approve")],
    });
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    expect(polls.map((p) => p.id)).toEqual(["approve-spec"]);
    expect(outcome.state.spec.decisions[0]!.answer.source).toBe("delegated");
  });
});

describe("runCockpit — pause paths", () => {
  it("pauses on the budget wall before running a fork's fan-out", async () => {
    const interro = scriptedInterrogate([forkMove()]);
    const conseq = fakeConsequence();
    const { interactor, polls } = fakeInteractor([]);
    // false at the turn-start gate, true at the fork gate — the fan-out never launches
    let checks = 0;
    const budget = { wouldExceed: () => ++checks >= 2, charge: () => {} };
    const outcome = await runCockpit({
      forTask: (k) => (k === "interrogate" ? interro.backend : conseq.backend),
      interactor,
      mastery: fakeMastery().model,
      prompts,
      orchestration: orchestration(),
      runId: "r",
      task: "t",
      budget,
    });
    expect(outcome).toMatchObject({ status: "paused", reason: "budget" });
    expect(polls).toHaveLength(0);
    expect(conseq.calls).toHaveLength(0);
  });

  it("pauses at max_polls before asking one poll too many", async () => {
    const { deps, polls } = makeDeps([forkMove("f1"), forkMove("f2")], {
      orchestration: orchestration({ max_polls: 1 }),
      answers: [pilotPicks("a"), pilotPicks("a")],
    });
    const outcome = await runCockpit(deps);
    expect(outcome).toMatchObject({ status: "paused", reason: "max_polls" });
    expect(polls.map((p) => p.id)).toEqual(["f1"]); // the second fork never reached the pilot
    expect(outcome.state.polls).toBe(1);
  });

  it("pauses when the interactor dies (ask resolves null)", async () => {
    const { deps } = makeDeps([forkMove()], { answers: [() => null] });
    const outcome = await runCockpit(deps);
    expect(outcome).toMatchObject({ status: "paused", reason: "interactor-lost" });
  });

  it("a malformed move gets exactly one retry, then pauses", async () => {
    const { deps, interrogateCalls } = makeDeps(["not json at all", "{ still broken"]);
    const outcome = await runCockpit(deps);
    expect(outcome).toMatchObject({ status: "paused", reason: "interrogator-malformed" });
    expect(interrogateCalls).toHaveLength(2);
  });

  it("three consecutive premature done moves pause as stalled", async () => {
    const { deps, interrogateCalls } = makeDeps([DONE, DONE, DONE]);
    const outcome = await runCockpit(deps);
    expect(outcome).toMatchObject({ status: "paused", reason: "interrogator-stalled" });
    expect(interrogateCalls).toHaveLength(3);
    // the agent was told what remains between stalls
    expect(interrogateCalls[1]!.task).toContain("api-spec");
  });
});

describe("runCockpit — details", () => {
  it("tolerates fenced JSON moves (cosmetic noise is not a failed turn)", async () => {
    const fenced = '```json\n{"move":"done"}\n```';
    const { deps } = makeDeps([fenced, fenced, fenced]);
    const outcome = await runCockpit(deps);
    // parsed as done (stall), NOT as malformed — malformed would pause after 2 calls
    expect(outcome).toMatchObject({ status: "paused", reason: "interrogator-stalled" });
  });

  it("omits teaching when the mastery treatment is plain poll", async () => {
    const mastery = fakeMastery("poll");
    const { deps, polls } = makeDeps([forkMove(), ...allSectionsContent, DONE], {
      mastery: mastery.model,
      answers: [pilotPicks("a")],
      autoApprove: true,
    });
    await runCockpit(deps);
    expect(polls[0]!.teaching).toBeUndefined();
  });

  it("a delegated pilot answer is observed as delegated, not confident", async () => {
    const { deps, observed } = makeDeps([forkMove(), ...allSectionsContent, DONE], {
      answers: [(poll) => ({ pollId: poll.id, optionId: poll.defaultOptionId, source: "delegated" })],
      autoApprove: true,
    });
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    expect(observed[0]!.outcome).toEqual({ confident: false, delegated: true });
    expect(outcome.state.spec.decisions[0]!.answer.source).toBe("delegated");
  });

  it("revise at the approve poll keeps interrogating instead of exiting", async () => {
    const { deps, polls } = makeDeps([...allSectionsContent, DONE, DONE], {
      answers: [
        (poll) => ({ pollId: poll.id, optionId: "revise", freeText: "tighten the API section", source: "pilot" }),
        pilotPicks("approve"),
      ],
    });
    const outcome = await runCockpit(deps);
    expect(outcome.status).toBe("approved");
    expect(polls.map((p) => p.id)).toEqual(["approve-spec", "approve-spec"]);
  });
});
