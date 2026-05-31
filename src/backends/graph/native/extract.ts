// Dependency-free source extraction for the native knowledge graph (Phase 5). This is the seam where
// web-tree-sitter belongs in production — a fast, error-tolerant, multi-grammar parser. Until that
// WASM toolchain is wired, this heuristic extractor covers the common languages well enough to build a
// correct graph and pass the conformance suite, and it is INJECTABLE on the graph so tree-sitter drops
// in without touching build.ts or native.ts. It is honest about its limits: in-file declarations are
// certain, cross-file relationships the builder resolves are marked `inferred`, never presented as fact.
import { extname } from "node:path";
import type { NodeKind } from "../types";

export interface RawDecl {
  name: string;
  kind: NodeKind;
  line: number;
}
export interface RawImport {
  spec: string; // the module specifier, resolved to a file by the builder
}
export interface RawRef {
  name: string; // an identifier used in a call position — a potential edge, resolved by the builder
  line: number;
}
export interface ExtractResult {
  decls: RawDecl[];
  imports: RawImport[];
  refs: RawRef[];
  supported: boolean; // false for a language we have no grammar for → an opaque file node, never a crash
}

const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXT = new Set([".py"]);

export function isSupportedSource(path: string): boolean {
  const e = extname(path).toLowerCase();
  return TS_EXT.has(e) || PY_EXT.has(e);
}

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

function extractTs(content: string): Omit<ExtractResult, "supported"> {
  const decls: RawDecl[] = [];
  const imports: RawImport[] = [];
  const refs: RawRef[] = [];
  const declRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of content.matchAll(declRe)) {
    const kw = m[1]!;
    const kind: NodeKind = kw === "class" ? "class" : kw === "function" ? "function" : "variable";
    decls.push({ name: m[2]!, kind, line: lineOf(content, m.index ?? 0) });
  }
  const impRe = /\b(?:import\b[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(impRe)) imports.push({ spec: m[1]! });
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of content.matchAll(callRe)) refs.push({ name: m[1]!, line: lineOf(content, m.index ?? 0) });
  return { decls, imports, refs };
}

function extractPy(content: string): Omit<ExtractResult, "supported"> {
  const decls: RawDecl[] = [];
  const imports: RawImport[] = [];
  const refs: RawRef[] = [];
  const declRe = /^[ \t]*(def|class)\s+([A-Za-z_]\w*)/gm;
  for (const m of content.matchAll(declRe)) {
    decls.push({ name: m[2]!, kind: m[1] === "class" ? "class" : "function", line: lineOf(content, m.index ?? 0) });
  }
  const impRe = /^[ \t]*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
  for (const m of content.matchAll(impRe)) imports.push({ spec: (m[1] ?? m[2])! });
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  for (const m of content.matchAll(callRe)) refs.push({ name: m[1]!, line: lineOf(content, m.index ?? 0) });
  return { decls, imports, refs };
}

export function extractFile(path: string, content: string): ExtractResult {
  const e = extname(path).toLowerCase();
  if (TS_EXT.has(e)) return { ...extractTs(content), supported: true };
  if (PY_EXT.has(e)) return { ...extractPy(content), supported: true };
  return { decls: [], imports: [], refs: [], supported: false };
}
