// The terminal Interactor — the Phase 1 cockpit surface. Renders each poll as plain hand-aligned
// text (like `corpocode why` — no color deps, no TTY assumptions) and reads one line at a time:
// a number picks an option, "d" delegates, anything else is a free-text answer when the poll
// allows it. Streams are injected so tests drive the whole exchange over PassThrough pipes and
// never need a real terminal.
//
// Fail-open per the Interactor contract: ask() NEVER throws and never hangs forever. A dead input
// (EOF, destroyed stream, error) resolves the poll's declared default (`source: "default"`) or
// null — the caller pauses the run — rather than crashing or guessing. close() is idempotent.
import { createInterface, type Interface } from "node:readline/promises";
import type { Answer, AxisFinding, Interactor, Poll, PollOption } from "./types";

export interface TerminalInteractorOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// ── rendering (pure string building; the write is the only IO) ──────────────────────────────────

const SEVERITY_WIDTH = 4; // "info" | "warn" | "risk" — all four chars, kept explicit for alignment

/** One finding row. A failed fan-out agent (`ok: false`) renders as "unanalyzed", never as a
 *  confident-looking blank — the pilot must see which axes the recommendation ignored. */
function findingRow(f: AxisFinding, axisWidth: number): string {
  const sev = f.ok ? f.severity : "?";
  const summary = f.ok ? f.summary : "unanalyzed";
  return `       ${f.axis.padEnd(axisWidth)}  ${sev.padEnd(SEVERITY_WIDTH)}  ${summary}`;
}

function renderOption(opt: PollOption, index: number): string[] {
  const lines = [`  ${index + 1}. ${opt.label}${opt.recommended ? "  (recommended)" : ""}`];
  if (opt.description) lines.push(`     ${opt.description}`);
  if (opt.findings.length > 0) {
    const axisWidth = Math.max(...opt.findings.map((f) => f.axis.length));
    for (const f of opt.findings) lines.push(findingRow(f, axisWidth));
  }
  return lines;
}

/** The teaching block precedes the question, framed so it reads as background, not as the ask. */
function renderTeaching(poll: Poll): string[] {
  if (!poll.teaching) return [];
  return [`── teaching: ${poll.teaching.concept} ${"─".repeat(Math.max(4, 60 - poll.teaching.concept.length))}`, poll.teaching.body, "─".repeat(74), ""];
}

function renderHint(poll: Poll): string {
  const parts = [`pick 1-${poll.options.length}`];
  if (poll.allowDelegate) parts.push(`"d" to delegate`);
  if (poll.allowFreeText) parts.push("or type your answer");
  return `  (${parts.join(", ")})`;
}

function renderPoll(poll: Poll): string {
  const lines = [...renderTeaching(poll), poll.question, ""];
  poll.options.forEach((opt, i) => lines.push(...renderOption(opt, i)));
  lines.push("", renderHint(poll));
  return `${lines.join("\n")}\n`;
}

// ── answer resolution ────────────────────────────────────────────────────────────────────────────

/** Delegation resolves to the recommendation when one exists, else the default, else the first
 *  option — "you decide" must always land on a real option so the ledger stays well-formed. */
function delegatedOptionId(poll: Poll): string | undefined {
  return poll.options.find((o) => o.recommended)?.id ?? poll.defaultOptionId ?? poll.options[0]?.id;
}

/** The dead-channel resolution: the declared default, or null (the caller pauses the run). */
function resolveDefault(poll: Poll): Answer | null {
  return poll.defaultOptionId ? { pollId: poll.id, optionId: poll.defaultOptionId, source: "default" } : null;
}

// ── the interactor ───────────────────────────────────────────────────────────────────────────────

export function createTerminalInteractor(opts: TerminalInteractorOptions = {}): Interactor {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  let closed = false;
  let rl: Interface | null = null;
  // Lines are buffered here rather than read via rl.question(): readline emits (and question
  // would discard) any line that arrives before a question is pending, but a piped answers
  // stream legitimately delivers input ahead of the render. The queue also makes EOF handling
  // exact — a pending read resolves null the moment the channel dies, so ask() can never hang.
  const pending: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;

  const signalClosed = (): void => {
    closed = true;
    waiter?.(null);
    waiter = null;
  };

  try {
    rl = createInterface({ input, output });
    rl.on("line", (line) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else pending.push(line);
    });
    rl.on("close", signalClosed);
    input.on("error", signalClosed); // a destroyed pipe errors instead of closing cleanly
  } catch {
    signalClosed(); // an unopenable surface behaves exactly like one that died immediately
  }

  const write = (text: string): void => {
    try {
      output.write(text);
    } catch {
      // best-effort narration — a broken output must not take the run down
    }
  };

  /** One line from the pilot, or null when the channel is (or becomes) dead. Buffered lines
   *  drain even after close so answers piped ahead of EOF are never lost. */
  function readLine(prompt: string): Promise<string | null> {
    write(prompt);
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (closed || !rl) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  return {
    async ask(poll: Poll): Promise<Answer | null> {
      try {
        write(renderPoll(poll));
        // Re-prompt until the pilot gives something interpretable; EOF breaks out to the default.
        for (;;) {
          const line = await readLine("> ");
          if (line === null) return resolveDefault(poll);
          const text = line.trim();
          if (text === "d" && poll.allowDelegate) {
            const optionId = delegatedOptionId(poll);
            return optionId ? { pollId: poll.id, optionId, source: "delegated" } : resolveDefault(poll);
          }
          if (/^\d+$/.test(text)) {
            const picked = poll.options[Number(text) - 1];
            if (picked) return { pollId: poll.id, optionId: picked.id, source: "pilot" };
            write(`  no option ${text} —${renderHint(poll).slice(2)}\n`);
            continue;
          }
          if (text && poll.allowFreeText) return { pollId: poll.id, freeText: text, source: "pilot" };
          write(`${renderHint(poll)}\n`);
        }
      } catch {
        // ask() never throws — an unexpected failure reads as a dead channel
        return resolveDefault(poll);
      }
    },

    say(block: string): void {
      write(`${block}\n`);
    },

    async close(): Promise<void> {
      if (closed) return;
      signalClosed();
      try {
        rl?.close();
      } catch {
        // already-destroyed streams may throw on close; idempotence wins
      }
    },
  };
}
