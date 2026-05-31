// Selects the KnowledgeGraph implementation by config.backends.knowledgeGraph. Consumers call
// this, never an adapter directly, so the Phase 5 native swap is a one-word config change.
import { cwd } from "node:process";
import type { CorpoConfig } from "../../config/schema";
import type { KnowledgeGraph } from "./types";
import { createGraphifyAdapter } from "./graphify-adapter";
import type { GraphifyTransport } from "./graphify-transport";
import { createNativeGraph } from "./native";

export function buildKnowledgeGraph(
  config: CorpoConfig,
  opts: { repoRoot?: string; transport?: GraphifyTransport } = {},
): KnowledgeGraph {
  const repoRoot = opts.repoRoot ?? cwd();
  switch (config.backends.knowledgeGraph) {
    case "graphify":
      return createGraphifyAdapter({ repoRoot, ...(opts.transport ? { transport: opts.transport } : {}) });
    case "native":
      return createNativeGraph({ repoRoot });
    default: {
      const unreachable: never = config.backends.knowledgeGraph;
      throw new Error(`unsupported knowledgeGraph backend: ${String(unreachable)}`);
    }
  }
}
