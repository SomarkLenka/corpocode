// Lightweight, dependency-free symbol extraction over TypeScript source. Two jobs, both heuristic by
// design: a full parser is overkill for "name the exported things" and "grab a declaration line", and
// keeping this regex-only means the doc generator never needs a language server to run. When precision
// matters more than reach, both functions are injectable on the generator (see generator.ts).

const IDENT = "[A-Za-z_$][\\w$]*";

/** Top-level exported symbols, in source order, de-duplicated. Used to pick which units to document. */
export function extractExportedSymbols(source: string): string[] {
  const re = new RegExp(
    `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|abstract\\s+class|class|const|let|var)\\s+(${IDENT})`,
    "g",
  );
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(re)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** The declaration "signature" of a symbol, whitespace-normalized; `null` if not found. A change to
 * this string is what `refresh` treats as staleness. Covers the common function/arrow/class forms. */
export function extractSignature(source: string, symbol: string): string | null {
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${s}\\s*\\([^)]*\\)[^{\\n]*`),
    new RegExp(`(?:export\\s+)?const\\s+${s}\\s*(?::[^=\\n]+)?=\\s*(?:async\\s*)?\\([^)]*\\)[^=\\n]*=>`),
    new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${s}\\b[^{\\n]*`),
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}
