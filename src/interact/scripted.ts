// The scripted Interactor — the `--answers` file for CI and the fake for tests. A run driven by a
// script answers polls from an ordered rule list instead of a human; each rule is consumed once,
// so a script reads top-to-bottom like a transcript of the interview it expects.
//
// The deliberate hard edge: a poll with no matching rule resolves the declared default or null
// (pausing the run). CI must be explicit about every decision it accepts — a script that silently
// answered questions it never anticipated would be worse than a paused run.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Answer, Interactor, Poll } from "./types";

/** One scripted answer. `poll`/`concept` are matchers (exact poll id / substring on concept — a
 *  rule with neither matches anything); `option`/`freeText`/`delegate` say how to answer. */
export interface ScriptedAnswerRule {
  poll?: string;
  concept?: string;
  option?: string; // an option id OR an exact label — labels read better in hand-written scripts
  freeText?: string;
  delegate?: boolean;
}

export interface ScriptedAnswers {
  answers: ScriptedAnswerRule[];
}

export const scriptedAnswersSchema = z.object({
  answers: z.array(
    z.object({
      poll: z.string().optional(),
      concept: z.string().optional(),
      option: z.string().optional(),
      freeText: z.string().optional(),
      delegate: z.boolean().optional(),
    }),
  ),
});

/** Load and validate an answers file. Fail-open: missing/unreadable/malformed ⇒ null, never a
 *  throw — the caller reports "no answers file" and the run proceeds unscripted. */
export function loadAnswersFile(path: string, readFile?: (p: string) => string | null): ScriptedAnswers | null {
  const read =
    readFile ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const raw = read(path);
  if (raw === null) return null;
  try {
    const parsed = scriptedAnswersSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Mirrors the terminal's delegation rule so scripted and live runs land on the same option:
 *  the recommendation when one exists, else the default, else the first option. */
function delegatedOptionId(poll: Poll): string | undefined {
  return poll.options.find((o) => o.recommended)?.id ?? poll.defaultOptionId ?? poll.options[0]?.id;
}

function resolveDefault(poll: Poll): Answer | null {
  return poll.defaultOptionId ? { pollId: poll.id, optionId: poll.defaultOptionId, source: "default" } : null;
}

function ruleMatches(rule: ScriptedAnswerRule, poll: Poll): boolean {
  if (rule.poll !== undefined && rule.poll !== poll.id) return false;
  if (rule.concept !== undefined && !poll.concept.includes(rule.concept)) return false;
  return true;
}

/** Apply one matched rule. Null means the rule couldn't produce a legal answer for this poll
 *  (unknown option name, freeText where the poll forbids it) — degrade to the default path
 *  rather than fabricate a choice the script never made. */
function resolveRule(rule: ScriptedAnswerRule, poll: Poll): Answer | null {
  if (rule.delegate) {
    const optionId = delegatedOptionId(poll);
    return optionId ? { pollId: poll.id, optionId, source: "delegated" } : null;
  }
  if (rule.option !== undefined) {
    const picked = poll.options.find((o) => o.id === rule.option || o.label === rule.option);
    return picked ? { pollId: poll.id, optionId: picked.id, source: "pilot" } : null;
  }
  if (rule.freeText !== undefined && poll.allowFreeText) {
    return { pollId: poll.id, freeText: rule.freeText, source: "pilot" };
  }
  return null;
}

export function createScriptedInteractor(script: ScriptedAnswers, opts?: { output?: (block: string) => void }): Interactor {
  const consumed = new Set<number>();

  return {
    async ask(poll: Poll): Promise<Answer | null> {
      try {
        // First unconsumed rule whose matchers fit wins; it is spent even when it can't produce a
        // legal answer — the script author's ordering stays predictable either way.
        for (let i = 0; i < script.answers.length; i++) {
          if (consumed.has(i) || !ruleMatches(script.answers[i], poll)) continue;
          consumed.add(i);
          return resolveRule(script.answers[i], poll) ?? resolveDefault(poll);
        }
        return resolveDefault(poll);
      } catch {
        // ask() never throws — a corrupt script reads as an exhausted one
        return resolveDefault(poll);
      }
    },

    say(block: string): void {
      try {
        opts?.output?.(block); // default: swallowed — scripted runs narrate only when asked to
      } catch {
        // narration is best-effort
      }
    },

    async close(): Promise<void> {
      // nothing to release; kept async + idempotent to honor the Interactor contract
    },
  };
}
