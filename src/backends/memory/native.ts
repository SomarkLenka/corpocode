// Native MemoryStore. Records live as flat per-project JSON; embeddings live in a sibling file.
// recall + capture are the categorizer's hot path; consolidate (with supersession) and
// recordOutcome close the write side so CorpoCode learns across sessions rather than starting fresh.
//
// Supersession, not deletion: when a new decision/approach reverses an existing one, the old
// memory's `supersededBy` pointer is set so recall returns the current truth while the prior
// decision stays auditable — a struck-through changelog entry, never an erased one.
//
// Robustness rule (the In-flight tenet): a missing or corrupt store degrades to empty recall and
// never throws into a turn.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ensureDir, memoryDir, memoryEmbeddingsFile, memoryFile } from "../../config/paths";
import type { Transcript } from "../../compactor/types";
import { cosineSimilarity, localEmbedder, type Embedder } from "./embedder";
import type {
  ConsolidationResult,
  Memory,
  MemoryInput,
  MemoryKind,
  MemoryStore,
  RecallOptions,
  Scope,
  ScoredMemory,
} from "./types";

const DECAYING_KINDS = new Set(["decision", "approach"]);
// Only decisions and approaches can be "reversed" by later work; a mistake or rule is never
// silently overturned — it stays protective until explicitly removed.
const REVERSIBLE_KINDS = new Set<MemoryKind>(["decision", "approach"]);
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_CONFLICT_THRESHOLD = 0.6; // cosine above which a same-kind memory is "the same topic"
const REVERSAL_FLOOR = 0.2; // a miner-flagged reversal still needs minimal topical overlap to bind
const MS_PER_DAY = 86_400_000;
const WORKSPACE_PROJECT = "__workspace__";

/** One memory mined from a transcript by `consolidate`, before it is assigned an id and embedded. */
export interface MinedMemory {
  kind: MemoryKind;
  text: string;
  files?: string[];
  reverses?: boolean; // the miner observed this explicitly overturning an earlier same-kind memory
}

/** Extracts typed memories from a finished session. Default is keyless (regex); a provider-backed
 *  miner can be injected for richer extraction without changing the store's contract. */
export type MemoryMiner = (transcript: Transcript) => Promise<MinedMemory[]>;

export interface NativeMemoryOptions {
  project: string;
  env?: NodeJS.ProcessEnv;
  embedder?: Embedder;
  now?: () => number;
  genId?: () => string;
  halfLifeDays?: number;
  miner?: MemoryMiner;
  conflictThreshold?: number;
}

// Keyless default miner: pull decision-cue lines from assistant turns. Deterministic and offline,
// so consolidation works with no provider; a provider-backed MemoryMiner can be injected to enrich.
const DECISION_CUES = [/\bdecided?\b/i, /\bwe(?:'ll| will| should)\s+use\b/i, /\bchose\b/i, /\bgoing with\b/i];
async function defaultMiner(transcript: Transcript): Promise<MinedMemory[]> {
  const mined: MinedMemory[] = [];
  for (const msg of transcript.messages) {
    if (msg.role !== "assistant") continue;
    for (const line of msg.content.split(/\n+/)) {
      const trimmed = line.trim();
      if (trimmed.length > 10 && DECISION_CUES.some((c) => c.test(trimmed))) {
        mined.push({ kind: "decision", text: trimmed });
      }
    }
  }
  return mined;
}

type Embeddings = Record<string, number[]>;

/**
 * The live, same-kind memory a newly-mined one most likely overturns, or null if none is close
 * enough. A miner-flagged reversal binds on minimal overlap (REVERSAL_FLOOR); otherwise the topical
 * match must clear `threshold`. Only records with a stored embedding are considered (all captured
 * ones have one), keeping this a fast synchronous pass.
 */
function findLiveConflict(
  records: Memory[],
  embeddings: Embeddings,
  mined: MinedMemory,
  minedEmb: number[],
  threshold: number,
): Memory | null {
  let best: Memory | null = null;
  let bestSim = -1;
  for (const r of records) {
    if (r.supersededBy) continue;
    if (r.kind !== mined.kind) continue;
    if (r.text === mined.text) continue; // an identical restatement is not a reversal
    const emb = embeddings[r.id];
    if (!emb) continue;
    const sim = cosineSimilarity(minedEmb, emb);
    if (sim > bestSim) {
      bestSim = sim;
      best = r;
    }
  }
  if (!best) return null;
  if (mined.reverses && bestSim >= REVERSAL_FLOOR) return best;
  return bestSim >= threshold ? best : null;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value as T;
  } catch {
    return fallback; // missing or corrupt → fallback, never throw
  }
}

export function createNativeMemoryStore(opts: NativeMemoryOptions): MemoryStore {
  const env = opts.env;
  const embedder = opts.embedder ?? localEmbedder();
  const now = opts.now ?? (() => Date.now());
  const genId = opts.genId ?? (() => randomUUID());
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const miner = opts.miner ?? defaultMiner;
  const conflictThreshold = opts.conflictThreshold ?? DEFAULT_CONFLICT_THRESHOLD;

  const recordsPath = (project: string): string => memoryFile(project, env);
  const embeddingsPath = (project: string): string => memoryEmbeddingsFile(project, env);

  const loadRecords = (project: string): Memory[] => {
    const value = readJson<Memory[]>(recordsPath(project), []);
    return Array.isArray(value) ? value : [];
  };
  const loadEmbeddings = (project: string): Embeddings =>
    readJson<Embeddings>(embeddingsPath(project), {});

  const save = (project: string, records: Memory[], embeddings: Embeddings): void => {
    ensureDir(memoryDir(env));
    writeFileSync(recordsPath(project), JSON.stringify(records, null, 2));
    writeFileSync(embeddingsPath(project), JSON.stringify(embeddings));
  };

  const recencyWeight = (m: Memory): number => {
    if (!DECAYING_KINDS.has(m.kind)) return 1; // mistakes/rules never decay — they stay protective
    const ageDays = Math.max(0, (now() - m.createdAt) / MS_PER_DAY);
    return 0.5 ** (ageDays / halfLifeDays);
  };

  const outcomeWeight = (m: Memory): number => {
    const outcomes = m.outcomes ?? [];
    if (outcomes.length === 0) return 1;
    const passes = outcomes.filter((o) => o.passed).length;
    const fails = outcomes.length - passes;
    return Math.min(1.5, Math.max(0.5, 1 + 0.15 * (passes - fails)));
  };

  async function appendMany(project: string, inputs: MemoryInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const records = loadRecords(project);
    const embeddings = loadEmbeddings(project);
    for (const input of inputs) {
      const mem: Memory = {
        id: genId(),
        kind: input.kind,
        text: input.text,
        createdAt: now(),
        ...(input.files ? { files: input.files } : {}),
      };
      records.push(mem);
      embeddings[mem.id] = await embedder.embed(mem.text);
    }
    save(project, records, embeddings);
    return inputs.length;
  }

  return {
    id: "native",

    async recall(opts: RecallOptions): Promise<ScoredMemory[]> {
      const projects = [opts.scope.project];
      if (opts.scope.workspaceCascade) projects.push(WORKSPACE_PROJECT);

      const pool: Array<{ memory: Memory; embeddings: Embeddings }> = [];
      for (const project of projects) {
        const records = loadRecords(project);
        const embeddings = loadEmbeddings(project);
        for (const memory of records) pool.push({ memory, embeddings });
      }

      // Supersession: a replaced memory is invisible to recall.
      let candidates = pool.filter(({ memory }) => !memory.supersededBy);

      if (opts.kinds) candidates = candidates.filter(({ memory }) => opts.kinds!.includes(memory.kind));
      if (opts.file) {
        candidates = candidates.filter(({ memory }) => (memory.files ?? []).includes(opts.file!));
      }

      const queryEmbedding = opts.query ? await embedder.embed(opts.query) : null;

      const scored: ScoredMemory[] = await Promise.all(
        candidates.map(async ({ memory, embeddings }) => {
          let semantic = 1;
          if (queryEmbedding) {
            const memEmbedding = embeddings[memory.id] ?? (await embedder.embed(memory.text));
            semantic = cosineSimilarity(queryEmbedding, memEmbedding);
          }
          const score = semantic * recencyWeight(memory) * outcomeWeight(memory);
          return { ...memory, score };
        }),
      );

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, opts.limit);
    },

    async capture(m: MemoryInput): Promise<void> {
      // capture is project-scoped via the input's session→project mapping handled by the caller;
      // the store writes to the configured project for this instance.
      await appendMany(opts.project, [m]);
    },

    async consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult> {
      // Mine typed memories from the transcript, then reconcile each against what is already
      // stored: a new decision/approach that reverses a live one retires the old by pointer
      // (supersededBy), never by deletion — recall gets the current truth, history stays legible.
      const mined = await miner(transcript);
      if (mined.length === 0) return { captured: 0, superseded: 0 };

      const records = loadRecords(scope.project);
      const embeddings = loadEmbeddings(scope.project);
      let captured = 0;
      let superseded = 0;

      for (const m of mined) {
        const id = genId();
        const emb = await embedder.embed(m.text);
        if (REVERSIBLE_KINDS.has(m.kind)) {
          const conflict = findLiveConflict(records, embeddings, m, emb, conflictThreshold);
          if (conflict) {
            conflict.supersededBy = id;
            superseded++;
          }
        }
        records.push({
          id,
          kind: m.kind,
          text: m.text,
          createdAt: now(),
          ...(m.files ? { files: m.files } : {}),
        });
        embeddings[id] = emb;
        captured++;
      }

      save(scope.project, records, embeddings);
      return { captured, superseded };
    },

    async recordOutcome(o): Promise<void> {
      const records = loadRecords(opts.project);
      const ids = new Set(o.recalledIds);
      let changed = false;
      for (const memory of records) {
        if (ids.has(memory.id)) {
          (memory.outcomes ??= []).push({ passed: o.passed, at: now() });
          changed = true;
        }
      }
      if (changed) save(opts.project, records, loadEmbeddings(opts.project));
    },

    async ping(): Promise<boolean> {
      try {
        ensureDir(memoryDir(env));
        return true;
      } catch {
        return false;
      }
    },
  };
}
