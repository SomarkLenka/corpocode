// The sliding window splits a transcript into a PRESERVED region (kept verbatim) and a COMPACTABLE
// region (distilled into memory). The single inviolable rule: the preserved turns are NEVER
// compacted — the model always keeps its most recent context in full, and compaction only ever
// touches the older material that has aged out of the window.
import type { TranscriptMessage } from "./types";

export interface SlidingWindow {
  preserved_turns: number; // recent conversation turns (non-tool messages) kept verbatim
  preserved_tool_outputs: number; // recent tool outputs kept verbatim (they are large)
}

export interface WindowSplit {
  preserved: TranscriptMessage[];
  compactable: TranscriptMessage[];
}

const isTool = (m: TranscriptMessage): boolean => m.role === "tool";

/**
 * Index where the preserved region begins, given how many of a kind to keep. Returns the index of
 * the nth-from-end match; if fewer than n exist, the index of the earliest match (preserve them
 * all); if none exist, `messages.length` (this kind imposes no constraint).
 */
function preserveStartIndex(messages: TranscriptMessage[], keep: (m: TranscriptMessage) => boolean, n: number): number {
  if (n <= 0) return messages.length;
  let count = 0;
  let earliest = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (keep(messages[i]!)) {
      count++;
      earliest = i;
      if (count === n) return i;
    }
  }
  return earliest;
}

export function computeWindow(messages: TranscriptMessage[], window: SlidingWindow): WindowSplit {
  const turnCut = preserveStartIndex(messages, (m) => !isTool(m), window.preserved_turns);
  const toolCut = preserveStartIndex(messages, isTool, window.preserved_tool_outputs);
  const cut = Math.min(turnCut, toolCut);
  return { preserved: messages.slice(cut), compactable: messages.slice(0, cut) };
}
