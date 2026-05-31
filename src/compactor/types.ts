// The parsed transcript shape that the compactor (Phase 2) and MemoryStore.consolidate consume.
// Declared here in Phase 1 because MemoryStore references it; the compactor that produces a
// compressed form of the same transcript is a Phase 2 deliverable.

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  ts?: number; // epoch ms when the message was recorded, if known
}

export interface Transcript {
  sessionId: string;
  messages: TranscriptMessage[];
}
