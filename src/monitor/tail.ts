// Incremental file reading for the monitor's live stream. Two small, cohesive pieces:
//   - createTailer: follow ONE append-only file from a byte offset, returning only the bytes added
//     since the last read. Handles the three states a tailed file can be in — not yet created,
//     grown, or truncated/rotated — and never throws into the caller (it degrades to "" so one
//     stream's read error can't take the server down; In-flight tenet).
//   - createLineBuffer: turn a stream of arbitrary text chunks into complete lines, holding back a
//     partial trailing line until its newline arrives (writes can be observed mid-line).
// The flow log's block buffering lives in flow-parse.ts instead, since its unit is a block, not a line.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface Tailer {
  /** Read bytes appended since the last call; "" when nothing is new or the file is absent. */
  read(): string;
  /** Current byte offset into the file (exposed for assertions/diagnostics). */
  readonly offset: number;
}

export function createTailer(file: string): Tailer {
  let offset = 0;

  function read(): string {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return ""; // not created yet (corpocode hasn't run) — wait for it to appear
    }
    if (size < offset) offset = 0; // truncated or rotated → re-read from the top
    if (size === offset) return ""; // no new bytes

    const fd = openSync(file, "r");
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = size;
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  return {
    read,
    get offset() {
      return offset;
    },
  };
}

export interface LineBuffer {
  /** Append a chunk; return the complete lines it finishes, buffering any partial trailing line. */
  push(chunk: string): string[];
}

export function createLineBuffer(): LineBuffer {
  let pending = "";
  return {
    push(chunk: string): string[] {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? ""; // last element is the (possibly empty) partial line
      return parts.filter((l) => l.length > 0); // drop blank separators between records
    },
  };
}
