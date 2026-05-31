// Selects the MemoryStore implementation. There is only one (native) and there is no planned
// swap, but the factory is kept symmetric with the graph/context registries so call sites look
// the same across all three knowledge abstractions.
import { cwd } from "node:process";
import { projectKey } from "../../config/paths";
import type { CorpoConfig } from "../../config/schema";
import { createNativeMemoryStore } from "./native";
import type { Embedder } from "./embedder";
import type { MemoryStore } from "./types";

export function buildMemoryStore(
  _config: CorpoConfig,
  opts: { project?: string; env?: NodeJS.ProcessEnv; embedder?: Embedder; repoRoot?: string } = {},
): MemoryStore {
  const project = opts.project ?? projectKey(opts.repoRoot ?? cwd());
  return createNativeMemoryStore({ project, env: opts.env, embedder: opts.embedder });
}
