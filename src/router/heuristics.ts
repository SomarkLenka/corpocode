// Stage 1 of the categorizer: free and fast. Trivial prompts early-exit at zero cost; everything
// else gets a candidate file set from the KnowledgeGraph (which surfaces structurally-central files
// the prompt never names). A thin string-overlap fallback covers only the window after a repo is
// initialized but before its graph has been built.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { KnowledgeGraph, ScoredFile } from "../backends/graph/types";
import type { ThoughtState } from "../session/types";

export interface RouterHeuristicConfig {
  heuristic_candidate_limit_files: number;
  trivial_early_exit: boolean;
}

export interface HeuristicResult {
  trivial: boolean;
  candidates: ScoredFile[];
  usedFallback: boolean;
}

export interface StageOneDeps {
  graph: KnowledgeGraph;
  repoRoot: string;
  listFiles?: (repoRoot: string) => string[];
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** A prompt cheap enough that classifying it would cost more than it's worth. */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  if (p.length <= 3) return true;
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|cool)\b/.test(p)) return true;
  if (/^\s*what\s+is\s+\d+\s*[+\-*/]\s*\d+/.test(p)) return true; // "what is 2+2"
  return false;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "bin", "coverage", "graphify-out", ".next", "build", ".turbo",
]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|md|json|ya?ml|toml)$/i;

function defaultListFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length > 2000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > 2000) return;
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (SOURCE_RE.test(e.name)) out.push(relative(repoRoot, full).replace(/\\/g, "/"));
    }
  };
  walk(repoRoot, 0);
  return out;
}

function stringOverlapFallback(
  query: string,
  repoRoot: string,
  limit: number,
  listFiles?: (repoRoot: string) => string[],
): ScoredFile[] {
  const files = (listFiles ?? defaultListFiles)(repoRoot);
  const queryTokens = new Set(tokenize(query));
  const scored = files
    .map((path) => {
      const pathTokens = tokenize(path);
      const overlap = pathTokens.filter((t) => queryTokens.has(t)).length;
      const score = pathTokens.length ? overlap / pathTokens.length : 0;
      return { path, score, nodeId: path, reason: "string-overlap fallback" };
    })
    .filter((f) => f.score > 0);
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

/** Run stage one, folding the line of thought into the graph query. */
export async function stageOne(
  prompt: string,
  thought: ThoughtState,
  deps: StageOneDeps,
  cfg: RouterHeuristicConfig,
): Promise<HeuristicResult> {
  if (cfg.trivial_early_exit && isTrivialPrompt(prompt)) {
    return { trivial: true, candidates: [], usedFallback: false };
  }
  const query = [prompt, thought.intent, ...thought.entities].filter(Boolean).join(" ");
  try {
    const scored = await deps.graph.scoreFiles(query, { limit: cfg.heuristic_candidate_limit_files });
    if (scored.length > 0) return { trivial: false, candidates: scored, usedFallback: false };
  } catch {
    // Graph unavailable (not yet built / daemon down) → degrade to string overlap (the I tenet).
  }
  const candidates = stringOverlapFallback(query, deps.repoRoot, cfg.heuristic_candidate_limit_files, deps.listFiles);
  return { trivial: false, candidates, usedFallback: true };
}
