// Assemble a knowledge graph from extracted source. The shape mirrors what graphify produced, so the
// traversals in native.ts and the conformance suite are identical. Centrality is inbound-weighted (how
// much the rest of the graph points AT a file, excluding mere ownership), so a file that is imported and
// called — the kind most likely central to a change — ranks above one that only imports and calls.
import { basename, dirname, join } from "node:path";
import type { GraphEdge, GraphNode } from "../types";
import { extractFile, type ExtractResult } from "./extract";

export interface SourceFile {
  path: string; // repo-relative, forward slashes
  content: string;
}

export interface NativeGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ParseFn = (path: string, content: string) => ExtractResult;

const CONTENT_CAP = 200_000; // a single pathological file never dominates the build
const fileId = (p: string): string => `file:${p}`;
const symId = (p: string, name: string): string => `sym:${p}#${name}`;

/** Resolve a relative import specifier to a known file path, trying the usual extensions. */
function resolveImport(fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // external/stdlib import → no internal edge
  const base = join(dirname(fromFile), spec).replace(/\\/g, "/");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}.py`, `${base}/__init__.py`];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

interface FileInfo {
  path: string;
  result: ExtractResult;
}

export function buildGraph(files: SourceFile[], parse: ParseFn = extractFile): NativeGraphData {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const known = new Set(files.map((f) => f.path));
  const infos: FileInfo[] = [];

  // 1. File and symbol nodes + `defines` edges. An unsupported language yields just the opaque file node.
  for (const f of files) {
    nodes.set(fileId(f.path), { id: fileId(f.path), name: basename(f.path), kind: "file", path: f.path });
    const result = parse(f.path, f.content.slice(0, CONTENT_CAP));
    for (const d of result.decls) {
      const id = symId(f.path, d.name);
      if (!nodes.has(id)) {
        nodes.set(id, { id, name: d.name, kind: d.kind, path: f.path, span: { startLine: d.line, endLine: d.line } });
        edges.push({ from: fileId(f.path), to: id, kind: "defines", confidence: "extracted" });
      }
    }
    infos.push({ path: f.path, result });
  }

  // 2. Import edges (resolved relative imports are certain → extracted).
  for (const info of infos) {
    for (const imp of info.result.imports) {
      const target = resolveImport(info.path, imp.spec, known);
      if (target) edges.push({ from: fileId(info.path), to: fileId(target), kind: "imports", confidence: "extracted" });
    }
  }

  // 3. Call edges: a reference is attributed to its enclosing declaration → the referenced symbol.
  // Cross-file resolution is heuristic, so these are honestly marked `inferred`.
  const declByName = new Map<string, { path: string; name: string }>();
  for (const info of infos) {
    for (const d of info.result.decls) if (!declByName.has(d.name)) declByName.set(d.name, { path: info.path, name: d.name });
  }
  const seen = new Set<string>();
  for (const info of infos) {
    const sorted = [...info.result.decls].sort((a, b) => a.line - b.line);
    const enclosing = (line: number): string => {
      let cur = fileId(info.path);
      for (const d of sorted) {
        if (d.line <= line) cur = symId(info.path, d.name);
        else break;
      }
      return cur;
    };
    for (const ref of info.result.refs) {
      const target = declByName.get(ref.name);
      if (!target) continue;
      const toId = symId(target.path, target.name);
      const fromId = enclosing(ref.line);
      if (fromId === toId) continue; // a declaration referencing itself is not a call
      const key = `${fromId}->${toId}`;
      if (seen.has(key)) continue; // one call edge per (caller, callee), not one per reference
      seen.add(key);
      edges.push({ from: fromId, to: toId, kind: "calls", confidence: "inferred" });
    }
  }

  // 4. Inbound centrality (excluding `defines`, which is ownership not dependency), normalized to [0,1].
  const inDegree = new Map<string, number>();
  for (const e of edges) {
    if (e.kind === "defines") continue;
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  const fileWeight = new Map<string, number>();
  for (const f of files) {
    let w = inDegree.get(fileId(f.path)) ?? 0;
    for (const node of nodes.values()) {
      if (node.path === f.path && node.kind !== "file") w += inDegree.get(node.id) ?? 0;
    }
    fileWeight.set(f.path, w);
  }
  const maxW = Math.max(1, ...fileWeight.values());
  for (const f of files) {
    const node = nodes.get(fileId(f.path));
    if (node) node.centrality = (fileWeight.get(f.path) ?? 0) / maxW;
  }

  return { nodes: [...nodes.values()], edges };
}
