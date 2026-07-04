// Deterministic poll assembly — NEVER a model call. The fan-out's structured findings fold into a
// Poll here with plain arithmetic, so the recommendation is auditable and reproducible: the same
// findings always produce the same recommendation, and a gap in the analysis is shown, not hidden.
import type { AxisFinding, Poll, PollOption, TeachingBlock } from "../interact/types";
import type { AgentTaskResult } from "../intelligence/types";
import type { DecisionFork } from "./types";
import type { AxisFindingPayload } from "./consequences";

const SEVERITY_RANK: Record<AxisFinding["severity"], number> = { info: 0, warn: 1, risk: 2 };

/** Defensive shape check — the backend validates schema output, but a fake/degraded backend may hand
 *  back anything; a malformed payload renders as "unanalyzed" rather than corrupting the poll. */
function isPayload(v: unknown): v is AxisFindingPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.summary === "string" && (p.severity === "info" || p.severity === "warn" || p.severity === "risk");
}

export function synthesizePoll(
  fork: DecisionFork,
  results: AgentTaskResult<AxisFindingPayload>[],
  opts: { axes: string[]; teaching?: TeachingBlock; allowDelegate: boolean },
): Poll {
  const byId = new Map(results.map((r) => [r.id, r.result] as const));

  // The full option×axis matrix. A missing or failed task becomes an explicit ok:false finding so the
  // pilot SEES the gap — an absent cell would read as "no concern", which is the opposite of the truth.
  const options: PollOption[] = fork.options.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description,
    findings: opts.axes.map((axis): AxisFinding => {
      const result = byId.get(`${option.id}::${axis}`);
      if (result?.ok && isPayload(result.data)) {
        return { axis, optionId: option.id, summary: result.data.summary, severity: result.data.severity, ok: true };
      }
      return { axis, optionId: option.id, summary: "unanalyzed", severity: "info", ok: false };
    }),
  }));

  // Majority-of-axes fold: per axis the least-bad option(s) win it (an all-tie axis has no winner);
  // most axis wins overall → recommended + defaultOptionId. An overall tie yields NEITHER — with no
  // default, a dying interactor makes ask() resolve null → the run pauses. Deliberate: a genuinely
  // contested fork must not be settled by a coin flip while nobody is watching.
  const wins = new Map<string, number>(options.map((o) => [o.id, 0]));
  for (const axis of opts.axes) {
    const ranks = options.map((o) => {
      const finding = o.findings.find((f) => f.axis === axis);
      return { id: o.id, rank: SEVERITY_RANK[finding?.severity ?? "info"] };
    });
    const best = Math.min(...ranks.map((r) => r.rank));
    const winners = ranks.filter((r) => r.rank === best);
    if (winners.length === ranks.length) continue; // every option ties — the axis discriminates nothing
    for (const w of winners) wins.set(w.id, (wins.get(w.id) ?? 0) + 1);
  }
  const most = Math.max(0, ...wins.values());
  const leaders = options.filter((o) => most > 0 && wins.get(o.id) === most);
  const recommended = leaders.length === 1 ? leaders[0] : undefined;
  if (recommended) recommended.recommended = true;

  return {
    id: fork.id,
    concept: fork.concept,
    question: fork.question,
    options,
    teaching: opts.teaching,
    allowFreeText: true,
    allowDelegate: opts.allowDelegate,
    defaultOptionId: recommended?.id,
  };
}

/** Phase-1 deterministic teaching: name the concept, restate the question, digest the COMPUTED
 *  consequences per option. Zero model calls — generated-and-verified teaching is Phase 5. */
export function renderTeaching(fork: DecisionFork, findings: AxisFinding[]): TeachingBlock {
  const lines = [`This decision exercises "${fork.concept}".`, fork.question, ""];
  for (const option of fork.options) {
    const analyzed = findings.filter((f) => f.optionId === option.id && f.ok);
    const digest = analyzed.length
      ? analyzed.map((f) => `${f.axis} (${f.severity}): ${f.summary}`).join(" | ")
      : "no analyzed consequences";
    lines.push(`- ${option.label}: ${digest}`);
  }
  return { concept: fork.concept, body: lines.join("\n") };
}
