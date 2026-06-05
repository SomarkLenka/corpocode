// Stop-hook handler — the transcript compactor. It runs after the model finishes, with two jobs
// that pull together: keep the working context lean (the sliding window) and preserve what the
// session learned (the digest written to tiered memory, plus consolidation into typed memory).
//
// Resilience is the whole point here. A compaction failure must NEVER surface as a session error:
// the digest write falls back from the daemon to a plain directory, consolidation and outcome
// recording are best-effort, and the entire handler is wrapped so any unexpected error degrades to
// an empty response. The plane keeps flying with the compactor's engine out.
import { readFileSync } from "node:fs";
import type { HookContext } from "../hooks/context";
import type { HookResponse } from "../hooks/response";
import type { StopEnvelope } from "../hooks/envelope";
import type { Transcript, TranscriptMessage } from "./types";
import { parseTranscriptSlice } from "../session/reader";
import { readLastDecision } from "../session/decision-cache";
import { computeWindow } from "./sliding-window";
import { writeDigest } from "./openviking";
import { writeMemdir } from "./memdir";
import { maybePromote, tracedFiles } from "../git/hook";
import { runDocGeneration } from "../docs/stop";

function readTranscript(path: string, sessionId: string): Transcript {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // no transcript on disk → an empty one (nothing to compact)
  }
  return { sessionId, messages: parseTranscriptSlice(text) };
}

/** Keyless fallback digest, used when the compactor provider is unavailable. */
function plainDigest(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n")
    .slice(0, 4000);
}

async function makeDigest(ctx: HookContext, messages: TranscriptMessage[]): Promise<string> {
  const body = messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 12000);
  try {
    const out = await ctx.registry.forComponent("compactor").chat({
      system: ctx.prompts.resolve("compactor"),
      maxTokens: 600,
      messages: [{ role: "user", content: body }],
    });
    return out.text.trim() || plainDigest(messages);
  } catch {
    return plainDigest(messages);
  }
}

/** Write the digest to the configured primary backend, falling back to memdir on any failure. */
async function writeWithFallback(
  ctx: HookContext,
  sessionId: string,
  turn: string,
  digest: string,
): Promise<"openviking" | "memdir"> {
  if (ctx.config.compaction.backend === "memdir") {
    writeMemdir(sessionId, turn, digest, ctx.env);
    return "memdir";
  }
  try {
    await writeDigest(ctx.context, sessionId, turn, digest);
    return "openviking";
  } catch {
    // The adapter already made its single restart attempt; a still-down daemon falls back here so
    // the learning is never lost and the session never sees an error.
    writeMemdir(sessionId, turn, digest, ctx.env);
    return "memdir";
  }
}

export async function handleStop(envelope: StopEnvelope, ctx: HookContext): Promise<HookResponse> {
  try {
    const transcript = readTranscript(envelope.transcript_path, envelope.session_id);
    const split = computeWindow(transcript.messages, ctx.config.sliding_window);
    const turn = String(transcript.messages.length);
    const scope = { project: ctx.project, workspaceCascade: false };

    let backend: "openviking" | "memdir" | "none" = "none";
    if (split.compactable.length > 0) {
      const digest = await makeDigest(ctx, split.compactable);
      backend = await writeWithFallback(ctx, envelope.session_id, turn, digest);
    }

    // Consolidate typed memory (mines + resolves supersession) — the call site that finally
    // exercises the writing side built for this phase.
    let consolidated = { captured: 0, superseded: 0 };
    try {
      consolidated = await ctx.memory.consolidate(transcript, scope);
    } catch {
      // consolidation is best-effort
    }

    // Close the outcome loop: reweight whatever was recalled this session. Without a cross-process
    // pass/fail signal we record a neutral-positive outcome; a future phase can refine the signal.
    const decision = readLastDecision(envelope.session_id, ctx.repoRoot, ctx.env);
    if (decision?.recalledIds.length) {
      try {
        await ctx.memory.recordOutcome({ recalledIds: decision.recalledIds, passed: true, sessionId: envelope.session_id });
      } catch {
        // best-effort
      }
    }

    ctx.logger.log({
      event: "compaction",
      session_id: envelope.session_id,
      component: "compactor",
      backend,
      preserved: split.preserved.length,
      compacted: split.compactable.length,
      captured: consolidated.captured,
      superseded: consolidated.superseded,
    });

    // A Stop is a natural unit boundary, so this is where the trace branch's granular history is
    // curated onto the clean branch. Best-effort: a non-repo, a disabled config, or any git error
    // must never turn a finished turn into a session error.
    try {
      const promotion = await maybePromote(ctx, envelope.session_id);
      if (promotion) {
        ctx.logger.log({
          event: "git",
          session_id: envelope.session_id,
          component: "git",
          op: "promote",
          branch: "clean",
          planned: promotion.planned,
          applied: promotion.applied,
          mode: promotion.mode,
        });
      }
    } catch {
      // git promotion is best-effort
    }

    // Document what the session touched (D tenet), on the same changed files the promotion grouped.
    // Best-effort and hard-capped inside runDocGeneration; an unchanged symbol costs nothing.
    try {
      const changed = await tracedFiles(ctx);
      if (changed.length > 0) {
        const docs = await runDocGeneration(ctx, changed);
        if (docs.symbols > 0) {
          ctx.logger.log({
            event: "docs",
            session_id: envelope.session_id,
            component: "docs",
            files: docs.files,
            symbols: docs.symbols,
          });
        }
      }
    } catch {
      // doc generation is best-effort
    }
  } catch (err) {
    ctx.logger.log({
      event: "compaction",
      session_id: envelope.session_id,
      component: "compactor",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {}; // the Stop hook never alters the host
}
