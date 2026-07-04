#!/usr/bin/env node
// The mission-drift lint. The reframe (docs/PHILOSOPHY.md MISSION block) retired a set of claims —
// "the expensive model writes the code", "Upper-Management is deferred", unconditional "ships dark" —
// that appeared near-verbatim across 15+ docs. Prose discipline alone will not keep them from creeping
// back in across that many files; this grep will. Wired into `npm run verify`.
//
// Each rule is a regex over *.md files (docs are the drift surface; source comments are reviewed in
// code review). Add a rule when a claim is retired; delete one only when the phrase becomes true again.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".corpocode", "bin"]);

const RULES = [
  { re: /only writes code/i, why: "the swarm writes the code; the expensive model verifies only" },
  { re: /stays on the keyboard/i, why: "the 'expensive model on the keyboard' framing is retired" },
  {
    re: /never write production code/i,
    why: "cheap agents author production code (haiku-helper's role-scoped form is 'do not write production code — you produce structured findings')",
  },
  { re: /Upper-Management is out of scope/i, why: "UM is the front door, built first" },
  { re: /designed, not built/i, why: "the UM deferral framing is retired" },
  { re: /scheduled after the agent substrate/i, why: "UM is no longer sequenced behind the substrate" },
  {
    // "ships dark" must always be qualified to the hook channel now that the orchestrator runs live.
    re: /ships dark(?! in (the )?hook)/i,
    why: 'unqualified "ships dark" — the substrate is live in orchestrator mode; write "ships dark in hook mode"',
  },
];

function mdFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...mdFiles(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

const failures = [];
for (const file of mdFiles(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) failures.push({ file: relative(ROOT, file), line: i + 1, why: rule.why, text: line.trim().slice(0, 120) });
    }
  });
}

if (failures.length) {
  process.stderr.write("mission drift detected — these claims were retired by the reframe:\n\n");
  for (const f of failures) process.stderr.write(`  ${f.file}:${f.line}  (${f.why})\n    ${f.text}\n`);
  process.stderr.write(`\n${failures.length} occurrence(s). Fix the doc (see docs/PHILOSOPHY.md) or, if a claim became true again, update scripts/check-mission.mjs in the same change.\n`);
  process.exit(1);
}
process.stdout.write("mission lint: clean\n");
