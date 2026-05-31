// The compactor's primary write path: land a digest under the agent-memory namespace, where the
// ContextStore daemon tiers it into L0/L1/L2 — so finished work doesn't vanish from context, it
// becomes hierarchical, retrievable memory a later retrieval pass can pull back at any depth.
import type { ContextStore } from "../backends/context/types";

export function memoryUri(sessionId: string, turn: string): string {
  return `viking://agent/memories/${sessionId}/${turn}.md`;
}

export async function writeDigest(
  context: ContextStore,
  sessionId: string,
  turn: string,
  digest: string,
): Promise<void> {
  await context.write(memoryUri(sessionId, turn), digest, { kind: "memory" });
}
