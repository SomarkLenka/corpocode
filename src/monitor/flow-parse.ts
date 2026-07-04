// Parse the flow log's text stream into discrete, header-tagged blocks for the monitor UI.
//
// src/log/flow.ts writes each hook as one block whose header is bordered by a RULE line:
//   <RULE>
//   ▶ <HookName>[  ·  <detail>]  ·  <ISO ts>  ·  session <short id>
//   <RULE>
//   ... transcript + hook-output sections ...
// Blocks are appended back-to-back, each prefixed with a leading newline. We split on the start
// marker "<RULE>\n▶ " so each block is recovered intact, and pull the header's four fields so the
// client can filter by session and colour by hook.
//
// Incremental safety: a block is only emitted once we can see its full header (the closing RULE).
// An earlier block is always complete (the next block's start marker bounds it); the trailing block
// is held in the buffer until its header finishes, so a write observed mid-block is never half-parsed.
import { RULE } from "../log/flow";

export { RULE };

export interface FlowBlock {
  hookName: string;
  detail?: string;
  ts?: string;
  sessionId?: string;
  /** The full raw block text, for verbatim display in the UI. */
  text: string;
}

export interface FlowParser {
  /** Append a chunk of flow-log text; return the blocks it completes. */
  push(chunk: string): FlowBlock[];
}

const MARKER = `${RULE}\n▶ `;
// A block's header is complete once its closing RULE has been written.
const HEADER_DONE = new RegExp(`^${RULE}\\n▶ [^\\n]*\\n${RULE}\\n`);
// Header field separator used by flow.ts: two spaces, a middot, two spaces.
const SEP = "  ·  ";

function parseHeader(text: string): FlowBlock {
  const m = text.match(new RegExp(`^${RULE}\\n▶ ([^\\n]*)\\n`));
  const headerLine = m?.[1] ?? "";
  const parts = headerLine.split(SEP);
  // Layout is [hook, (detail?), ts, "session <id>"]: hook first, session last, ts second-to-last,
  // and an optional detail in between.
  const hookName = parts[0] ?? "";
  const sessionPart = parts.length >= 3 ? parts[parts.length - 1] : undefined;
  const ts = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  const detail = parts.length >= 4 ? parts.slice(1, parts.length - 2).join(SEP) : undefined;
  const sessionId = sessionPart?.startsWith("session ") ? sessionPart.slice("session ".length) : sessionPart;
  return { hookName, detail, ts, sessionId, text };
}

function startIndices(buffer: string): number[] {
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const i = buffer.indexOf(MARKER, from);
    if (i < 0) break;
    starts.push(i);
    from = i + MARKER.length;
  }
  return starts;
}

export function createFlowParser(): FlowParser {
  let buffer = "";

  return {
    push(chunk: string): FlowBlock[] {
      buffer += chunk;
      const starts = startIndices(buffer);
      if (starts.length === 0) return []; // no block has begun yet

      const blocks: FlowBlock[] = [];
      let consumed = 0;
      for (let i = 0; i < starts.length; i++) {
        const isLast = i === starts.length - 1;
        const segEnd = isLast ? buffer.length : starts[i + 1]!;
        const seg = buffer.slice(starts[i]!, segEnd);
        if (!isLast) {
          // Bounded by the next block's start marker → fully written.
          blocks.push(parseHeader(seg));
          consumed = segEnd;
        } else if (HEADER_DONE.test(seg)) {
          blocks.push(parseHeader(seg));
          consumed = segEnd;
        } else {
          consumed = starts[i]!; // keep the partial trailing block for the next chunk
        }
      }
      buffer = buffer.slice(consumed);
      return blocks;
    },
  };
}
