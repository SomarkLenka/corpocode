// The cockpit driver — the ONLY impure module in the cockpit. Every boundary is injected (backends,
// interactor, mastery, budget, clock, log), so the whole interrogation runs end-to-end in tests over
// fakes; nothing here touches fs or spawns a process itself.
//
// Fail-open posture, cockpit flavor: nothing in this loop throws a run away. A malformed interrogator
// move gets one corrective retry then PAUSES; a dead interactor pauses; a budget wall pauses. Paused,
// not lost — the checkpointed SpecState in the outcome is everything needed to resume.
import { z } from "zod";
import { run } from "../intelligence/engine";
import type { AgentBackend, AgentCall, AgentResult, AgentTaskKind, ModelRef } from "../agents/backend";
import type { AgentTaskResult } from "../intelligence/types";
import type { CorpoConfig } from "../config/schema";
import type { Answer, Interactor, Poll } from "../interact/types";
import { SPEC_SECTIONS, type DecisionFork, type MasteryModel } from "./types";
import { specSectionIdSchema } from "./spec-schema";
import {
  initialState,
  isComplete,
  recordContent,
  recordDecision,
  sectionPayloadSchema,
  type SpecState,
} from "./interrogator";
import { consequencePlan, type AxisFindingPayload } from "./consequences";
import { renderTeaching, synthesizePoll } from "./poll-synth";

/** Prompt renderers are injected (src/prompts is owned elsewhere) so the loop never embeds prose. */
export interface CockpitPrompts {
  interrogate(vars: { task: string; remainingSections: string[]; grounding: string; lastAnswer?: string }): string;
  axis(axis: string, vars: { question: string; optionLabel: string; optionDescription?: string; concept: string }): string;
}

export interface CockpitDeps {
  forTask(kind: AgentTaskKind): AgentBackend;
  interactor: Interactor;
  mastery: MasteryModel;
  prompts: CockpitPrompts;
  orchestration: CorpoConfig["orchestrator"];
  runId: string;
  task: string;
  files?: string[];
  roleModels?: { interrogate?: ModelRef; consequence?: ModelRef };
  budget: {
    wouldExceed(phase: "spec", projectedUsd?: number): boolean;
    charge(phase: "spec", usd: number): void;
  };
  autoApprove?: boolean;
  /** Resume a paused interrogation from its persisted spec state (artifacts-as-checkpoints). The
   *  interrogate SESSION is not resumed — the agent re-orients from the state — but every decided
   *  fork and completed section survives, so no pilot answer is ever asked twice. */
  resumeState?: SpecState;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

export type CockpitOutcome = { status: "approved" | "paused" | "aborted"; state: SpecState; reason?: string };

// The MOVE PROTOCOL, as a Zod schema — the fixed cross-module contract with the interrogate prompt.
// `suggested` rides along on forks so the granularity dial can auto-resolve without a second call.
const moveSchema = z.discriminatedUnion("move", [
  z.object({
    move: z.literal("fork"),
    fork: z.object({
      id: z.string().min(1),
      section: specSectionIdSchema,
      concept: z.string().min(1),
      question: z.string().min(1),
      major: z.boolean(),
      suggested: z.string().optional(),
      options: z.array(z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() })).min(1),
    }),
  }),
  z.object({ move: z.literal("content"), section: specSectionIdSchema, complete: z.boolean(), payload: sectionPayloadSchema }),
  z.object({ move: z.literal("done") }),
]);
type Move = z.infer<typeof moveSchema>;

const MOVE_INSTRUCTION =
  'Reply with EXACTLY ONE JSON object and nothing else, in one of these shapes:\n' +
  '{"move":"fork","fork":{"id":"<kebab-slug>","section":"<section id>","concept":"<concept name>","question":"...","major":true|false,"suggested":"<option id>","options":[{"id":"a","label":"...","description":"..."}]}}\n' +
  '{"move":"content","section":"<section id>","complete":true|false,"payload":{<additive spec fragment>}}\n' +
  '{"move":"done"}';

const RETRY_NOTE =
  "\nYour previous reply was not one valid move JSON object. Reply again with exactly one JSON object matching the protocol above.";

/** Best-effort JSON extraction: models wrap JSON in fences or prose despite instructions; take the
 *  outermost object rather than failing the turn on cosmetic noise. */
function extractJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function parseMove(result: AgentResult): Move | null {
  if (!result.ok) return null;
  const raw = result.data ?? extractJson(result.text);
  const parsed = moveSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function runCockpit(deps: CockpitDeps): Promise<CockpitOutcome> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const interrogation = deps.orchestration.interrogation;
  const roles = deps.orchestration.roles;
  const grounding = (deps.files ?? []).join("\n");
  const interrogate = deps.forTask("interrogate");

  let state = deps.resumeState ?? initialState(deps.runId, deps.task);
  let sessionId: string | undefined; // the persistent interrogate thread, kept in-memory for the run
  let lastAnswer: string | undefined; // consumed once — fed into exactly the next interrogate turn
  let stalls = 0; // consecutive premature "done" moves

  const pause = (reason: string): CockpitOutcome => {
    log({ event: "cockpit_pause", run_id: deps.runId, reason, polls: state.polls });
    return { status: "paused", state, reason };
  };

  // One interrogate turn: render, invoke (persistent session), parse; a malformed move earns one
  // corrective retry in the SAME session, then null — the caller pauses.
  const nextMove = async (remainingSections: string[]): Promise<Move | null> => {
    const prompt = deps.prompts.interrogate({ task: deps.task, remainingSections, grounding, lastAnswer });
    lastAnswer = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const call: AgentCall = {
        component: "um",
        taskKind: "interrogate",
        task: `${prompt}\n\n${MOVE_INSTRUCTION}${attempt > 0 ? RETRY_NOTE : ""}`,
        inputs: deps.files ? { files: deps.files } : undefined,
        model: deps.roleModels?.interrogate,
        effort: roles.interrogate?.effort ?? "medium",
        timeoutMs: roles.interrogate?.timeout_ms,
        tools: "read-only",
        session: sessionId ? { reuse: sessionId } : { persist: true },
      };
      const result = await interrogate.invoke(call);
      deps.budget.charge("spec", result.usage.costUsd);
      if (result.session?.id) sessionId = result.session.id;
      const move = parseMove(result);
      if (move) return move;
    }
    return null;
  };

  while (true) {
    // Turn-start budget gate: a runaway interrogation stops at the wall even between forks.
    if (deps.budget.wouldExceed("spec")) return pause("budget");

    const remainingSections = SPEC_SECTIONS.filter((s) => state.spec.sections[s] !== "complete");
    const move = await nextMove(remainingSections);
    if (!move) return pause("interrogator-malformed");

    if (move.move === "content") {
      stalls = 0;
      state = recordContent(state, move.section, move.payload, move.complete);
      log({ event: "cockpit_move", move: "content", section: move.section, complete: move.complete });
      deps.interactor.note?.({ kind: "sections", statuses: { ...state.spec.sections } });
      continue;
    }

    if (move.move === "fork") {
      stalls = 0;
      const fork: DecisionFork = {
        id: move.fork.id,
        section: move.fork.section,
        concept: move.fork.concept,
        question: move.fork.question,
        options: move.fork.options,
        major: move.fork.major,
      };
      log({ event: "cockpit_move", move: "fork", fork_id: fork.id, section: fork.section, major: fork.major });

      // The granularity dial: which forks reach the human. Auto-resolved forks still hit the ledger
      // (source "delegated", empty findings) — the audit trail never has silent gaps.
      const ask =
        interrogation.granularity === "every-fork" ||
        (interrogation.granularity === "major-forks" && fork.major);

      if (!ask) {
        const chosen = fork.options.find((o) => o.id === move.fork.suggested) ?? fork.options[0]!;
        const answer: Answer = { pollId: fork.id, optionId: chosen.id, source: "delegated" };
        state = recordDecision(state, {
          pollId: fork.id,
          section: fork.section,
          concept: fork.concept,
          question: fork.question,
          options: fork.options.map((o) => ({ id: o.id, label: o.label, findings: [] })),
          answer,
          at: now(),
        });
        lastAnswer = `Fork "${fork.id}" was auto-resolved to "${chosen.label}" (delegated by poll granularity).`;
        log({ event: "cockpit_poll", poll_id: fork.id, asked: false, source: "delegated", option: chosen.id });
        deps.interactor.note?.({ kind: "decision", pollId: fork.id, concept: fork.concept, source: "delegated", chosen: chosen.label });
        deps.interactor.note?.({ kind: "sections", statuses: { ...state.spec.sections } });
        continue;
      }

      if (state.polls >= interrogation.max_polls) return pause("max_polls");
      if (deps.budget.wouldExceed("spec")) return pause("budget");

      const plan = consequencePlan(fork, {
        axes: interrogation.consequence_axes,
        fanoutWidth: interrogation.fanout_width,
        component: "um",
        model: deps.roleModels?.consequence,
        effort: roles.consequence?.effort ?? "minimal",
        timeoutMs: roles.consequence?.timeout_ms,
        files: deps.files,
        renderPrompt: (axis, option) =>
          deps.prompts.axis(axis, {
            question: fork.question,
            optionLabel: option.label,
            optionDescription: option.description,
            concept: fork.concept,
          }),
      });
      const fanout = await run(plan, { forTask: deps.forTask, log: deps.log, now: deps.now });
      deps.budget.charge("spec", fanout.usage.costUsd);

      let poll = synthesizePoll(fork, fanout.tasks as AgentTaskResult<AxisFindingPayload>[], {
        axes: interrogation.consequence_axes,
        allowDelegate: true,
      });
      if (interrogation.teach && deps.mastery.treatment(fork.concept) === "teach-then-poll") {
        poll = { ...poll, teaching: renderTeaching(fork, poll.options.flatMap((o) => o.findings)) };
      }

      const answer = await deps.interactor.ask(poll);
      if (!answer) return pause("interactor-lost");

      state = recordDecision(state, {
        pollId: poll.id,
        section: fork.section,
        concept: fork.concept,
        question: fork.question,
        // Findings embed in the ledger so the spec records not just WHAT was chosen but what the
        // pilot knew when choosing it.
        options: poll.options.map((o) => ({ id: o.id, label: o.label, findings: o.findings })),
        answer,
        at: now(),
      });
      deps.mastery.observe(fork.concept, {
        confident: answer.source === "pilot",
        delegated: answer.source !== "pilot",
      });
      const chosenLabel = answer.optionId
        ? fork.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId
        : undefined;
      lastAnswer = answer.freeText
        ? `On "${fork.question}" the pilot answered in their own words: ${answer.freeText}`
        : `On "${fork.question}" the pilot chose "${chosenLabel}".`;
      log({ event: "cockpit_poll", poll_id: poll.id, asked: true, source: answer.source, option: answer.optionId });
      deps.interactor.note?.({ kind: "decision", pollId: poll.id, concept: fork.concept, source: answer.source, chosen: chosenLabel ?? answer.freeText });
      deps.interactor.note?.({ kind: "sections", statuses: { ...state.spec.sections } });
      continue;
    }

    // move === "done"
    if (!isComplete(state)) {
      stalls += 1;
      log({ event: "cockpit_move", move: "done", premature: true, stalls });
      if (stalls >= 3) return pause("interrogator-stalled");
      lastAnswer = `The spec is NOT complete. Sections remaining: ${remainingSections.join(", ")}. Keep interrogating.`;
      continue;
    }
    log({ event: "cockpit_move", move: "done", premature: false });

    // The final approve poll — the only poll every granularity setting asks. No delegate, no default:
    // handing a spec to the swarm is the one decision that must not resolve while nobody is watching.
    let answer: Answer | null;
    if (deps.autoApprove) {
      answer = { pollId: "approve-spec", optionId: "approve", freeText: "--yes", source: "pilot" };
    } else {
      const approvePoll: Poll = {
        id: "approve-spec",
        concept: "spec-approval",
        question: "Approve this spec and hand it to the swarm, or request revisions?",
        options: [
          { id: "approve", label: "Approve", findings: [] },
          { id: "revise", label: "Revise", findings: [] },
        ],
        allowFreeText: true,
        allowDelegate: false,
        defaultOptionId: undefined,
      };
      answer = await deps.interactor.ask(approvePoll);
    }
    if (!answer) return pause("interactor-lost");

    if (answer.optionId === "approve") {
      state = { ...state, spec: { ...state.spec, approvedAt: now() } };
      log({ event: "cockpit_approved", run_id: deps.runId, polls: state.polls, decisions: state.spec.decisions.length });
      deps.interactor.note?.({ kind: "phase", phase: "approved", detail: `${state.spec.decisions.length} decision(s)` });
      return { status: "approved", state };
    }

    stalls = 0;
    lastAnswer = `The pilot wants revisions before approving${answer.freeText ? `: ${answer.freeText}` : ""}. Continue interrogating.`;
  }
}
