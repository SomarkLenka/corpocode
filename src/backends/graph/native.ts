// Native KnowledgeGraph (Phase 5) — a true drop-in for the graphify adapter, behind the identical
// interface and passing the identical conformance behaviors. No Python, no daemon, no cross-process
// hop: the graph is built in-process from source, persisted under the CorpoCode dir, and traversed in
// memory. The expensive full parse happens once (ensureBuilt) and is kept current by incremental
// refresh of only the changed files (refreshFiles), so the per-turn path is just fast memory reads.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { corpocodeHome, projectKey } from "../../config/paths";
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphPath,
  KnowledgeGraph,
  Neighborhood,
  ScoredFile,
  Subgraph,
} from "./types";
import { buildGraph, type NativeGraphData, type SourceFile } from "./native/build";
import { extractFile, type ExtractResult } from "./native/extract";

export interface GraphStore {
  read(): NativeGraphData | null;
  write(data: NativeGraphData): void;
  exists(): boolean;
}

export type NativeGraph = KnowledgeGraph & {
  /** Incremental refresh: re-parse ONLY these files, reuse cached parses for the rest, then rebuild. */
  refreshFiles(changed: string[]): Promise<void>;
};

export interface NativeGraphOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  loadFiles?: (repoRoot: string) => SourceFile[];
  parse?: (path: string, content: string) => ExtractResult;
  store?: GraphStore;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "bin", "coverage", "graphify-out", ".next", "build", ".turbo"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;
const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function defaultLoadFiles(repoRoot: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length > 4000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (SOURCE_RE.test(e.name)) {
        try {
          out.push({ path: relative(repoRoot, full).replace(/\\/g, "/"), content: readFileSync(full, "utf8") });
        } catch {
          // unreadable file → skip; the graph degrades, never throws
        }
      }
    }
  };
  walk(repoRoot, 0);
  return out;
}

function fileStore(path: string): GraphStore {
  return {
    exists: () => existsSync(path),
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as NativeGraphData;
      } catch {
        return null;
      }
    },
    write(data) {
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(data));
      } catch {
        // persistence is an optimization; a write failure just means the next start rebuilds
      }
    },
  };
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function createNativeGraph(opts: NativeGraphOptions): NativeGraph {
  const loadFiles = opts.loadFiles ?? defaultLoadFiles;
  const underlyingParse = opts.parse ?? extractFile;
  const store = opts.store ?? fileStore(join(corpocodeHome(opts.env), "graphs", `${projectKey(opts.repoRoot)}.json`));

  // Parse cache keyed on (path, content hash): a rebuild only invokes the real parser for files whose
  // content actually changed, which is what makes refresh incremental.
  const parseCache = new Map<string, { hash: string; result: ExtractResult }>();
  const cachedParse = (path: string, content: string): ExtractResult => {
    const hash = djb2(content);
    const hit = parseCache.get(path);
    if (hit && hit.hash === hash) return hit.result;
    const result = underlyingParse(path, content);
    parseCache.set(path, { hash, result });
    return result;
  };

  let data: NativeGraphData | null = null;

  const rebuild = (): NativeGraphData => {
    const built = buildGraph(loadFiles(opts.repoRoot), cachedParse);
    store.write(built);
    data = built;
    return built;
  };

  const ensureData = (): NativeGraphData => {
    if (data) return data;
    data = store.read() ?? rebuild();
    return data;
  };

  const byId = (d: NativeGraphData): Map<string, GraphNode> => new Map(d.nodes.map((n) => [n.id, n]));

  const adjacency = (d: NativeGraphData): Map<string, Set<string>> => {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    };
    for (const e of d.edges) {
      link(e.from, e.to);
      link(e.to, e.from);
    }
    return adj;
  };

  /** Nodes matching the prompt, plus their one-hop neighbors — the candidate set the prompt touches. */
  const candidateIds = (d: NativeGraphData, prompt: string): Set<string> => {
    const tokens = tokenize(prompt);
    const adj = adjacency(d);
    const ids = new Set<string>();
    for (const n of d.nodes) {
      const hay = `${n.name} ${n.path ?? ""}`.toLowerCase();
      if (tokens.some((t) => hay.includes(t))) {
        ids.add(n.id);
        for (const nb of adj.get(n.id) ?? []) ids.add(nb);
      }
    }
    return ids;
  };

  return {
    id: "native",

    async ping(): Promise<boolean> {
      return true; // in-process: always reachable (built lazily on first access)
    },

    async scoreFiles(prompt: string, o: { limit: number }): Promise<ScoredFile[]> {
      const d = ensureData();
      const map = byId(d);
      const tokens = tokenize(prompt);
      const files = new Map<string, ScoredFile>();
      for (const id of candidateIds(d, prompt)) {
        const node = map.get(id);
        if (!node?.path) continue;
        const fileNode = map.get(`file:${node.path}`);
        if (!fileNode || files.has(node.path)) continue;
        const hay = `${fileNode.name} ${node.path}`.toLowerCase();
        const overlap = tokens.length ? tokens.filter((t) => hay.includes(t)).length / tokens.length : 0;
        const score = (fileNode.centrality ?? 0) + 0.5 * overlap;
        files.set(node.path, { path: node.path, score, nodeId: fileNode.id, reason: "structural centrality + prompt overlap" });
      }
      return [...files.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, o.limit);
    },

    async getNode(name: string): Promise<GraphNode | null> {
      const d = ensureData();
      return d.nodes.find((n) => n.name === name) ?? null;
    },

    async getNeighbors(nodeId: string, o?: { depth?: number; edgeKinds?: EdgeKind[] }): Promise<Neighborhood> {
      const d = ensureData();
      const map = byId(d);
      const adj = adjacency(d);
      const depth = o?.depth ?? 1;
      const visited = new Set<string>([nodeId]);
      let frontier = [nodeId];
      for (let i = 0; i < depth; i++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const nb of adj.get(id) ?? []) if (!visited.has(nb)) {
            visited.add(nb);
            next.push(nb);
          }
        }
        frontier = next;
      }
      let edges = d.edges.filter((e) => visited.has(e.from) && visited.has(e.to));
      if (o?.edgeKinds) edges = edges.filter((e) => o.edgeKinds!.includes(e.kind));
      const center = map.get(nodeId) ?? { id: nodeId, name: nodeId, kind: "file" as const };
      const nodes = [...visited].filter((id) => id !== nodeId).map((id) => map.get(id)).filter((n): n is GraphNode => Boolean(n));
      return { center, nodes, edges, depth };
    },

    async findPath(fromId: string, toId: string): Promise<GraphPath | null> {
      const d = ensureData();
      const map = byId(d);
      if (!map.has(fromId) || !map.has(toId)) return null;
      const adj = adjacency(d);
      const prev = new Map<string, string>();
      const queue = [fromId];
      const seen = new Set([fromId]);
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === toId) break;
        for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) {
          seen.add(nb);
          prev.set(nb, cur);
          queue.push(nb);
        }
      }
      if (fromId !== toId && !prev.has(toId)) return null;
      const order: string[] = [];
      for (let cur: string | undefined = toId; cur !== undefined; cur = prev.get(cur)) {
        order.unshift(cur);
        if (cur === fromId) break;
      }
      const nodes = order.map((id) => map.get(id)).filter((n): n is GraphNode => Boolean(n));
      const inPath = new Set(order);
      const edges = d.edges.filter((e) => inPath.has(e.from) && inPath.has(e.to));
      return { from: fromId, to: toId, nodes, edges, length: order.length - 1 };
    },

    async query(q: string, o: { budget: number }): Promise<Subgraph> {
      const d = ensureData();
      const map = byId(d);
      const ids = [...candidateIds(d, q)];
      const truncated = o.budget < ids.length;
      const kept = new Set(truncated ? ids.slice(0, Math.max(0, o.budget)) : ids);
      const nodes = [...kept].map((id) => map.get(id)).filter((n): n is GraphNode => Boolean(n));
      const edges = d.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
      return { nodes, edges, query: q, budgetTokens: o.budget, truncated };
    },

    async ensureBuilt(_repoRoot: string): Promise<void> {
      if (!store.exists()) rebuild(); // build only when no persisted graph exists; otherwise skip
    },

    async refresh(_repoRoot: string): Promise<void> {
      parseCache.clear(); // a full refresh re-parses everything
      rebuild();
    },

    async refreshFiles(changed: string[]): Promise<void> {
      for (const path of changed) parseCache.delete(path.replace(/\\/g, "/")); // only these re-parse on rebuild
      rebuild();
    },
  };
}
