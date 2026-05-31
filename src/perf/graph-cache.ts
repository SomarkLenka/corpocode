// Memoize the graph's file-scoring across hooks (Phase 4 §4). Stage-1 scoring is the latency that sits
// directly between the user pressing enter and the model responding, and the same prompt against the
// same graph always yields the same candidates — so it is the highest-value thing to cache. The cache
// version is derived from the graph file itself, so the instant the graph is rebuilt the old scores are
// dropped: a hit is always against the current graph, never a stale one.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeGraph, ScoredFile } from "../backends/graph/types";
import { cacheFile, corpocodeHome, projectKey } from "../config/paths";
import { createCache, fileStore, type Cache } from "./cache";

/** A token that changes whenever the active graph is rebuilt, so a rebuild invalidates the cache. Both
 * graph locations are considered — graphify's `graphify-out/graph.json` and the native graph under the
 * CorpoCode dir — so the cache invalidates correctly whichever backend is in use. */
export function graphVersion(repoRoot: string, env?: NodeJS.ProcessEnv): string {
  const candidates = [
    join(repoRoot, "graphify-out", "graph.json"),
    join(corpocodeHome(env), "graphs", `${projectKey(repoRoot)}.json`),
  ];
  const parts = candidates.map((p) => {
    try {
      const st = statSync(p);
      return `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return "x";
    }
  });
  return parts.every((p) => p === "x") ? "none" : parts.join("|");
}

export interface ScoreFilesCacheOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  cache?: Cache<ScoredFile[]>; // injectable for tests
}

/** Return a copy of the graph whose scoreFiles is memoized; all other methods pass through unchanged. */
export function withScoreFilesCache(graph: KnowledgeGraph, opts: ScoreFilesCacheOptions): KnowledgeGraph {
  const cache =
    opts.cache ??
    createCache<ScoredFile[]>({ version: graphVersion(opts.repoRoot, opts.env), store: fileStore(cacheFile("scorefiles", opts.env)) });

  const scoreFiles = async (prompt: string, o: { limit: number }): Promise<ScoredFile[]> => {
    const key = `${o.limit}:${prompt}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const result = await graph.scoreFiles(prompt, o);
    cache.set(key, result);
    return result;
  };

  return { ...graph, scoreFiles };
}
