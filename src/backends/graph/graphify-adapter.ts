// graphify adapter: maps the KnowledgeGraph interface onto graphify's MCP tools, parsing each
// response tolerantly into our shapes. Only scoreFiles is wired into a live hook in Phase 1; the
// rest are implemented so the conformance suite covers the full surface.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphPath,
  KnowledgeGraph,
  Neighborhood,
  NodeKind,
  ScoredFile,
  Subgraph,
} from "./types";
import { spawnGraphifyTransport, type GraphifyTransport } from "./graphify-transport";

export interface GraphifyAdapterOptions {
  repoRoot: string;
  transport?: GraphifyTransport; // injectable; default spawns the MCP server
  graphPath?: string;
  pythonCmd?: string;
  runGraphify?: (repoRoot: string) => Promise<void>; // default runs `graphify .`
  graphExists?: (path: string) => boolean;
}

const NODE_KINDS: readonly NodeKind[] = [
  "file", "function", "class", "method", "variable", "module", "concept", "doc", "table", "endpoint",
];
const EDGE_KINDS: readonly EdgeKind[] = [
  "calls", "imports", "defines", "references", "inherits", "implements", "reads", "writes", "relates_to",
];

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function coerceNode(raw: unknown): GraphNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? r.name ?? "");
  if (!id) return null;
  return {
    id,
    name: String(r.name ?? r.id ?? ""),
    kind: NODE_KINDS.includes(r.kind as NodeKind) ? (r.kind as NodeKind) : "concept",
    ...(r.path ? { path: String(r.path) } : {}),
    ...(r.span ? { span: r.span as { startLine: number; endLine: number } } : {}),
    ...(r.summary ? { summary: String(r.summary) } : {}),
    ...(typeof r.centrality === "number" ? { centrality: r.centrality } : {}),
    ...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
  };
}

function coerceEdge(raw: unknown): GraphEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const from = String(r.from ?? "");
  const to = String(r.to ?? "");
  if (!from || !to) return null;
  return {
    from,
    to,
    kind: EDGE_KINDS.includes(r.kind as EdgeKind) ? (r.kind as EdgeKind) : "relates_to",
    confidence: (r.confidence as GraphEdge["confidence"]) ?? "inferred",
    ...(typeof r.weight === "number" ? { weight: r.weight } : {}),
  };
}

function extractNodes(raw: unknown): GraphNode[] {
  const container = raw as { nodes?: unknown; results?: unknown };
  const arr = Array.isArray(raw) ? raw : (container?.nodes ?? container?.results ?? []);
  return (Array.isArray(arr) ? arr : []).map(coerceNode).filter((n): n is GraphNode => n !== null);
}

function extractEdges(raw: unknown): GraphEdge[] {
  const arr = (raw as { edges?: unknown })?.edges;
  return (Array.isArray(arr) ? arr : []).map(coerceEdge).filter((e): e is GraphEdge => e !== null);
}

function defaultRunGraphify(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("graphify", ["."], { cwd: repoRoot, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`graphify exited ${code}`))));
  });
}

export function createGraphifyAdapter(opts: GraphifyAdapterOptions): KnowledgeGraph {
  const graphPath = opts.graphPath ?? join(opts.repoRoot, "graphify-out", "graph.json");
  const transport =
    opts.transport ??
    spawnGraphifyTransport({ repoRoot: opts.repoRoot, graphPath, pythonCmd: opts.pythonCmd });
  const runGraphify = opts.runGraphify ?? defaultRunGraphify;
  const graphExists = opts.graphExists ?? existsSync;

  return {
    id: "graphify",

    async scoreFiles(prompt, { limit }) {
      const nodes = extractNodes(await transport.callTool("query_graph", { query: prompt }));
      const files = nodes
        .filter((n) => n.kind === "file")
        // Deterministic ordering: centrality desc, then id asc as a stable tiebreak.
        .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0) || a.id.localeCompare(b.id));
      return files.slice(0, limit).map((n) => ({
        path: n.path ?? n.name,
        score: clamp01(n.centrality ?? 0),
        nodeId: n.id,
        ...(n.summary ? { reason: n.summary } : {}),
      }));
    },

    async getNode(name) {
      const raw = await transport.callTool("get_node", { name });
      if (!raw || (typeof raw === "object" && Object.keys(raw).length === 0)) return null;
      return coerceNode(raw);
    },

    async getNeighbors(nodeId, neighborOpts) {
      const depth = neighborOpts?.depth ?? 1;
      const raw = await transport.callTool("get_neighbors", { id: nodeId, depth });
      const container = (raw ?? {}) as { center?: unknown };
      const center = coerceNode(container.center) ?? { id: nodeId, name: nodeId, kind: "concept" as NodeKind };
      let edges = extractEdges(raw);
      if (neighborOpts?.edgeKinds) {
        const allowed = new Set(neighborOpts.edgeKinds);
        edges = edges.filter((e) => allowed.has(e.kind));
      }
      return { center, nodes: extractNodes(raw), edges, depth };
    },

    async findPath(fromId, toId) {
      const raw = await transport.callTool("shortest_path", { from: fromId, to: toId });
      const nodes = extractNodes(raw);
      if (nodes.length === 0) return null;
      const edges = extractEdges(raw);
      return { from: fromId, to: toId, nodes, edges, length: Math.max(0, nodes.length - 1) };
    },

    async query(query, { budget }) {
      const raw = await transport.callTool("query_graph", { query, budget });
      const truncated = Boolean((raw as { truncated?: boolean })?.truncated);
      return { nodes: extractNodes(raw), edges: extractEdges(raw), query, budgetTokens: budget, truncated };
    },

    async ensureBuilt(repoRoot) {
      if (!graphExists(graphPath)) await runGraphify(repoRoot);
    },

    async refresh(repoRoot) {
      await runGraphify(repoRoot);
    },

    ping: () => transport.ping(),
  };
}
