// The hook-mode non-regression guarantee, enforced STRUCTURALLY: the hook channel must behave
// byte-identically whether or not the orchestrator exists, so the hook-channel source tree is
// forbidden from (a) importing orchestrator code and (b) reading the `orchestrator` config block.
// If either grep ever matches, the guarantee is broken by construction — no behavioral test can
// substitute for this, because a behavioral test only covers the inputs it thought of.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = join(__dirname, "..", "..", "src");

/** Every source dir on the hook-channel path: dispatch + everything its handlers consume. */
const HOOK_CHANNEL_DIRS = [
  "hooks",
  "router",
  "session",
  "filter",
  "verifier",
  "review",
  "molar",
  "retrieval",
  "compactor",
  "toolbox",
  "docs",
  "git",
  "agents",
  "intelligence",
  "loops",
];

const FORBIDDEN_IMPORTS = [/from\s+["'][^"']*\/orchestrator\//, /from\s+["'][^"']*\/um\//, /from\s+["'][^"']*\/interact\//];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("hook-channel parity (structural)", () => {
  const files = HOOK_CHANNEL_DIRS.flatMap((d) => {
    try {
      return tsFilesUnder(join(SRC, d));
    } catch {
      return []; // a dir that doesn't exist yet simply contributes nothing
    }
  });

  it("collects a real hook-channel file set", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never imports orchestrator / um / interact code", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (FORBIDDEN_IMPORTS.some((re) => re.test(text))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("never reads the `orchestrator` config block", () => {
    // Property access only (`cfg.orchestrator`, `["orchestrator"]`) — the bare word in a comment
    // ("the orchestrator of this turn") is prose, not a config read.
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (/\w\.orchestrator\b/.test(text) || /\[["']orchestrator["']\]/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
