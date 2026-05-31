// Read/write the toolbox catalog — the gated skills'/agents' ORIGINAL descriptions, which the gate
// strips from the live files but the classifier needs to judge relevance. Fail-open: a missing or
// corrupt catalog reads as empty, and a write failure is swallowed (the gate is best-effort).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolboxCatalog } from "./types";

export function loadCatalog(path: string): ToolboxCatalog {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ToolboxCatalog;
    return parsed && Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

export function writeCatalog(path: string, catalog: ToolboxCatalog): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog, null, 2));
  } catch {
    // best-effort
  }
}
