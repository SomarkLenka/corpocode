// ContextStore — the tiered-context abstraction. Reference adapter: OpenViking. Declared in full
// in Phase 1, but its data path (find/load/write/tree/grep) is not wired into any hook until
// Phase 2; Phase 1 only provisions and health-checks the daemon so the operational story is whole.
import type { Pingable } from "../../types/common";

/** L0 ≈ 100-token abstract, L1 ≈ 2k-token overview, L2 = full original. */
export type Tier = "L0" | "L1" | "L2";

/** viking:// namespaces: agent/user memories, shared resources, skills. */
export type ResourceKind = "memory" | "resource" | "skill";

export interface Resource {
  uri: string;
  kind: ResourceKind;
  tier: Tier;
  content: string;
  tokens: number;
  score?: number;
  children?: string[];
}

export interface TreeEntry {
  uri: string;
  kind: ResourceKind | "directory";
  abstract?: string;
  childCount?: number;
}

export interface FindResult {
  query: string;
  tier: Tier;
  resources: Resource[];
  trajectory?: string[];
}

export interface ContextStore extends Pingable {
  readonly id: string; // "openviking" | "native"
  find(query: string, opts: { tier: Tier; limit: number; root?: string }): Promise<FindResult>;
  load(uri: string, tier: Tier): Promise<string>;
  write(uri: string, content: string, opts?: { kind?: ResourceKind }): Promise<void>;
  tree(uri: string, opts?: { depth?: number }): Promise<TreeEntry[]>;
  grep(pattern: string, opts?: { root?: string }): Promise<Resource[]>;
  start(): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
}
