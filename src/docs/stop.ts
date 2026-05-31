// Stop-hook orchestration for the doc generator. It runs in parallel with compaction on the files a
// session actually changed: refresh records a change staled, then document the changed files' exported
// symbols. Hard caps (files, symbols/file) keep the cost bounded — at most a handful of cheap passes
// per Stop, and document()'s signature gate means an unchanged symbol costs nothing. Best-effort by
// construction: every failure degrades to a smaller summary, never a session error (the I tenet).
import { readFileSync } from "node:fs";
import type { HookContext } from "../hooks/context";
import { isSource } from "../verifier/tenets/patterns";
import { extractExportedSymbols } from "./symbols";
import { createDocGenerator } from "./generator";

const MAX_FILES = 3;
const MAX_SYMBOLS_PER_FILE = 2;

export interface DocGenSummary {
  files: number;
  symbols: number;
}

export async function runDocGeneration(ctx: HookContext, changedFiles: string[]): Promise<DocGenSummary> {
  const sources = changedFiles.filter((f) => isSource(f)).slice(0, MAX_FILES);
  if (sources.length === 0) return { files: 0, symbols: 0 };

  const gen = createDocGenerator({
    provider: ctx.registry.forComponent("retrieval"),
    graph: ctx.graph,
    repoRoot: ctx.repoRoot,
  });

  // Refresh first: regenerate any existing record whose signature a change staled (cheap — pays only
  // on a real signature change), so a later document() of the same symbol short-circuits.
  await gen.refresh(sources);

  let symbols = 0;
  for (const file of sources) {
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // a vanished file is not an error here
    }
    for (const name of extractExportedSymbols(source).slice(0, MAX_SYMBOLS_PER_FILE)) {
      await gen.document(file, name); // idempotent: no model call when the record is already current
      symbols++;
    }
  }
  return { files: sources.length, symbols };
}
