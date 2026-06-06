// gather — the deterministic half of the IntelligentRouter. Before any (expensive) agent fans out, it
// pulls cheap, structural candidates from the three local backends so a pattern can build its plan from
// real signal: the graph's file scoring + neighborhoods, and the memory store's recalled rules/mistakes.
//
// This module is pure infrastructure: it takes a narrow, injected slice of HookContext (not the whole
// thing) so it unit-tests against fakes, and it is deterministic — no model calls happen here. Every
// source is independent and fail-open (the In-flight tenet): one backend being down (graph not yet
// built, memory unreadable) degrades that source to empty, never the whole gather. The optional
// retrieval fold is left OUT by default — `gather` is graph/memory-only until a pattern opts in.
import type { KnowledgeGraph, ScoredFile, GraphNode, Neighborhood } from "../backends/graph/types";
import type { MemoryStore, ScoredMemory } from "../backends/memory/types";
import type { RetrievalPackage } from "../retrieval/types";
import type { Logger } from "../log/ndjson";
import type { Intent } from "./types";

/** The deterministic candidate set a pattern turns into an OrchestrationPlan. Every field is best-effort. */
export interface Candidates {
  files: ScoredFile[];
  nodes: GraphNode[];
  neighborhoods: Neighborhood[];
  memories: ScoredMemory[];
  retrieval?: RetrievalPackage;
}

/** A narrow slice of HookContext — only what gather reads. Injected so the module tests with fakes. */
export interface GatherDeps {
  graph: KnowledgeGraph;
  memory: MemoryStore;
  project: string;
  limit?: number;
  logger?: Logger;
  /** Deferred concretion: a pattern may inject a retrieval fold; gather stays graph/memory-only by default. */
  runRetrieval?: (intent: Intent) => Promise<RetrievalPackage>;
}

const DEFAULT_LIMIT = 8;
const EMPTY: Candidates = { files: [], nodes: [], neighborhoods: [], memories: [] };

/** Resolve a settled promise to its value, or a fallback if it rejected — the per-source fail-open unit. */
async function settled<T>(p: Promise<T>, fallback: T, logger: Logger | undefined, source: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    logger?.log({ event: "gather_source_degraded", source, reason: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

/**
 * Pull deterministic candidates for an intent. `prompt` intents score files by the prompt + recall
 * rules/mistakes; file-scoped intents (`pre-write`/`pre-read`/`post-write`) center on the file's node +
 * neighborhood + file-scoped memories. Never throws — a dead backend yields an empty slice for that source.
 */
export async function gather(intent: Intent, deps: GatherDeps): Promise<Candidates> {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const scope = { project: deps.project, workspaceCascade: true };

  if (intent.kind === "prompt") {
    const [files, memories, retrieval] = await Promise.all([
      settled(deps.graph.scoreFiles(intent.prompt, { limit }), [] as ScoredFile[], deps.logger, "graph.scoreFiles"),
      settled(
        deps.memory.recall({ query: intent.prompt, kinds: ["mistake", "rule"], scope, limit }),
        [] as ScoredMemory[],
        deps.logger,
        "memory.recall",
      ),
      deps.runRetrieval ? settled(deps.runRetrieval(intent), undefined, deps.logger, "runRetrieval") : Promise.resolve(undefined),
    ]);
    return { files, nodes: [], neighborhoods: [], memories, retrieval };
  }

  // File-scoped intents: center on the file's graph node + its neighborhood, plus file-scoped memories.
  const file = intent.file;
  const node = await settled(deps.graph.getNode(file), null, deps.logger, "graph.getNode");
  const [neighborhood, memories] = await Promise.all([
    node ? settled(deps.graph.getNeighbors(node.id), null, deps.logger, "graph.getNeighbors") : Promise.resolve(null),
    settled(deps.memory.recall({ file, scope, limit }), [] as ScoredMemory[], deps.logger, "memory.recall"),
  ]);
  return {
    files: node?.path ? [{ path: node.path, score: 1, nodeId: node.id }] : [],
    nodes: node ? [node] : [],
    neighborhoods: neighborhood ? [neighborhood] : [],
    memories,
  };
}

export { EMPTY as EMPTY_CANDIDATES };
