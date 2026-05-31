// MemoryStore — the experiential-memory abstraction. Native from day one (no vendor adapter, no
// Phase 5 swap). It owns typed memories, supersession, and outcomes; it does NOT index code
// structure (KnowledgeGraph) or do tiered document retrieval (ContextStore).
import type { Pingable } from "../../types/common";
import type { Transcript } from "../../compactor/types";

export type MemoryKind = "decision" | "mistake" | "rule" | "approach";

export interface Scope {
  project: string; // per-project store at ~/.corpocode/memory/<project>.json
  workspaceCascade: boolean; // also recall workspace-level memories above the project
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;
  files?: string[]; // file anchors (mistakes and rules are often file-scoped)
  createdAt: number;
  supersededBy?: string; // id of the memory that replaced this one (set by consolidate, Phase 2)
  outcomes?: { passed: boolean; at: number }[]; // appended by recordOutcome
}

export interface ScoredMemory extends Memory {
  score: number; // semantic relevance × recency decay × outcome weight
}

export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  files?: string[];
  sessionId: string;
}

export interface ConsolidationResult {
  captured: number;
  superseded: number;
}

export interface RecallOptions {
  query?: string;
  file?: string;
  kinds?: MemoryKind[];
  scope: Scope;
  limit: number;
}

export interface MemoryStore extends Pingable {
  readonly id: string; // "native"
  recall(opts: RecallOptions): Promise<ScoredMemory[]>;
  capture(m: MemoryInput): Promise<void>;
  consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult>;
  recordOutcome(o: { recalledIds: string[]; passed: boolean; sessionId: string }): Promise<void>;
}
