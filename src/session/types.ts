// SessionReader — reads the running session transcript and distills the main model's line of
// thought so the rest of CorpoCode steers WITH the model rather than re-deriving the situation.
import type { MemoryKind } from "../backends/memory/types";

export interface ThoughtState {
  intent: string; // what the model is currently trying to accomplish
  approach?: string; // the approach it has settled on, if stated
  openQuestions: string[]; // questions it is actively working through
  recentDecisions: string[]; // decisions visible in the transcript this session
  entities: string[]; // symbols, files, concepts in active play — these seed retrieval
}

export interface RetrievalCues {
  query: string;
  files: string[];
  kinds?: MemoryKind[];
}

export interface SessionReader {
  /** Running understanding of the model's line of thought (cached per session, updated incrementally). */
  lineOfThought(sessionId: string, transcriptPath: string): Promise<ThoughtState>;
  /** Why a file is about to be read, inferred from the transcript; null when not obvious (then ask). */
  filePurpose(sessionId: string, file: string): Promise<string | null>;
  /** Cues that guide and augment retrieval across the three knowledge abstractions. */
  retrievalCues(sessionId: string): Promise<RetrievalCues>;
}
