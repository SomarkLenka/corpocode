// KnowledgeGraph — the structural-index abstraction. Reference adapter: graphify. The interface
// exposes only what the Phase 1 categorizer (scoreFiles) and the Phase 2 retrieval team
// (getNode/getNeighbors/findPath/query) actually need — never graphify's full surface.
import type { Pingable } from "../../types/common";

/** How confidently a relationship was derived. */
export type Confidence = "extracted" | "inferred" | "ambiguous";

export type NodeKind =
  | "file"
  | "function"
  | "class"
  | "method"
  | "variable"
  | "module"
  | "concept"
  | "doc"
  | "table"
  | "endpoint";

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  path?: string;
  span?: { startLine: number; endLine: number };
  summary?: string;
  centrality?: number; // higher = more structurally connected
  metadata?: Record<string, unknown>;
}

export type EdgeKind =
  | "calls"
  | "imports"
  | "defines"
  | "references"
  | "inherits"
  | "implements"
  | "reads"
  | "writes"
  | "relates_to";

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  weight?: number;
}

export interface ScoredFile {
  path: string;
  score: number; // 0..1 relevance to the prompt
  nodeId: string;
  reason?: string;
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
}

export interface GraphPath {
  from: string;
  to: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  length: number;
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  query: string;
  budgetTokens: number;
  truncated: boolean;
}

export interface KnowledgeGraph extends Pingable {
  readonly id: string; // "graphify" | "native"
  scoreFiles(prompt: string, opts: { limit: number }): Promise<ScoredFile[]>;
  getNode(name: string): Promise<GraphNode | null>;
  getNeighbors(nodeId: string, opts?: { depth?: number; edgeKinds?: EdgeKind[] }): Promise<Neighborhood>;
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;
  query(query: string, opts: { budget: number }): Promise<Subgraph>;
  ensureBuilt(repoRoot: string): Promise<void>;
  refresh(repoRoot: string): Promise<void>;
}
