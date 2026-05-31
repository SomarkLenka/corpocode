// The DocGenerator implementation. Each facet of the what-code-does record is its own single-purpose
// cheap pass, fanned out in parallel (the same decompose-then-aggregate shape the verifier and
// retrieval team use): one prompt, one job, and a failed facet degrades to empty rather than failing
// the whole record (the I tenet). `touches` is the exception — it is RESOLVED from the KnowledgeGraph's
// neighbors, never asked of the model, because the structural truth already exists in the graph.
//
// Persistence is a sidecar JSON beside the source (`<file>.cc-doc.json`), a map of symbol → record, so
// docs travel with the code and `refresh` can detect staleness by comparing the stored signature.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Provider } from "../providers/types";
import type { KnowledgeGraph } from "../backends/graph/types";
import { extractSignature as defaultExtractSignature } from "./symbols";
import type { DocGenerator, DocRecord, WhatCodeDoes } from "./types";

const CODE_CAP = 4000; // cheap-model context bound; a facet pass never needs the whole of a large file
const FACET_TOKENS = 280;

export interface DocGeneratorDeps {
  provider: Provider;
  graph: KnowledgeGraph;
  repoRoot: string;
  readFile?: (path: string) => string;
  readRecordFile?: (path: string) => string | null;
  writeRecordFile?: (path: string, content: string) => void;
  extractSignature?: (source: string, symbol: string) => string | null;
  now?: () => number;
}

/** The concrete factory's return type: the spec interface plus `document`, the persistence
 * orchestration the Stop wiring drives (kept off the interface so consumers depend only on the spec). */
export type DocGeneratorImpl = DocGenerator & {
  document(file: string, symbol: string): Promise<DocRecord>;
};

const EMPTY_WHAT: WhatCodeDoes = {
  impacts: [],
  touches: [],
  risks: [],
  futureConsiderations: [],
  input: { params: "", structure: "", mutabilityIfChanged: "" },
  transformation: { how: "", purpose: "" },
  output: { structure: "", considerations: "" },
};

const zItems = z.object({ items: z.array(z.string()) });
const zInput = z.object({ params: z.string(), structure: z.string(), mutabilityIfChanged: z.string() });
const zTransform = z.object({ how: z.string(), purpose: z.string() });
const zOutput = z.object({ structure: z.string(), considerations: z.string() });

function recordPath(file: string): string {
  return `${file}.cc-doc.json`;
}

export function createDocGenerator(deps: DocGeneratorDeps): DocGeneratorImpl {
  const provider = deps.provider;
  const graph = deps.graph;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const readRecordFile =
    deps.readRecordFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const writeRecordFile = deps.writeRecordFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const extractSignature = deps.extractSignature ?? defaultExtractSignature;
  const now = deps.now ?? (() => Date.now());

  /** Read a symbol's source context, capped for a cheap pass. Falls back to "" if the file is gone. */
  function codeContext(file: string): string {
    try {
      return readFile(file).slice(0, CODE_CAP);
    } catch {
      return "";
    }
  }

  /** One facet = one single-purpose JSON pass; any failure (timeout, bad JSON, schema miss) → fallback. */
  async function facet<T>(instruction: string, symbol: string, code: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    try {
      const out = await provider.chat({
        system: `${instruction} Focus only on the symbol \`${symbol}\`. Respond as JSON.`,
        messages: [{ role: "user", content: code }],
        responseFormat: "json",
        maxTokens: FACET_TOKENS,
      });
      return schema.parse(JSON.parse(out.text));
    } catch {
      return fallback;
    }
  }

  const listFacet = (instruction: string, symbol: string, code: string): Promise<string[]> =>
    facet(instruction, symbol, code, zItems, { items: [] }).then((r) => r.items);

  /** Resolve the blast radius from the graph's neighbors — the one facet that is looked up, not asked. */
  async function resolveTouches(symbol: string): Promise<string[]> {
    try {
      const node = await graph.getNode(symbol);
      if (!node) return [];
      const nb = await graph.getNeighbors(node.id, { depth: 1 });
      const paths = new Set<string>();
      for (const n of nb.nodes) if (n.path) paths.add(n.path);
      return [...paths];
    } catch {
      return [];
    }
  }

  /** Fan out every facet at once, then assemble deterministically. */
  async function buildWhatCodeDoes(symbol: string, code: string): Promise<WhatCodeDoes> {
    const [impacts, risks, futureConsiderations, input, transformation, output, touches] = await Promise.all([
      listFacet("List what this code impacts (the systems/behaviors it affects), as { items: string[] }.", symbol, code),
      listFacet("List the risks in this code, as { items: string[] }.", symbol, code),
      listFacet("List future considerations for this code, as { items: string[] }.", symbol, code),
      facet("Describe this code's input: { params, structure, mutabilityIfChanged }.", symbol, code, zInput, EMPTY_WHAT.input),
      facet("Describe this code's transformation: { how, purpose }.", symbol, code, zTransform, EMPTY_WHAT.transformation),
      facet("Describe this code's output: { structure, considerations }.", symbol, code, zOutput, EMPTY_WHAT.output),
      resolveTouches(symbol),
    ]);
    return { impacts, touches, risks, futureConsiderations, input, transformation, output };
  }

  async function inlineDocs(file: string, symbol: string): Promise<string> {
    const code = codeContext(file);
    try {
      const out = await provider.chat({
        system:
          "Write a concise documentation comment for the named symbol. Return only the comment text " +
          "(no code, no fences), explaining what it does and any non-obvious why. Under 6 lines. " +
          `Symbol: \`${symbol}\`.`,
        messages: [{ role: "user", content: code }],
        maxTokens: 200,
      });
      return out.text.trim();
    } catch {
      return "";
    }
  }

  async function generateRecord(file: string, symbol: string, source: string): Promise<DocRecord> {
    const code = source.slice(0, CODE_CAP);
    const [docs, what] = await Promise.all([inlineDocs(file, symbol), buildWhatCodeDoes(symbol, code)]);
    return {
      ...what,
      file,
      symbol,
      inlineDocs: docs,
      signature: extractSignature(source, symbol) ?? "",
      generatedAt: now(),
    };
  }

  function readRecords(file: string): Record<string, DocRecord> {
    const raw = readRecordFile(recordPath(file));
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, DocRecord>) : {};
    } catch {
      return {}; // a corrupt sidecar is treated as absent, never fatal (the I tenet)
    }
  }

  function writeRecords(file: string, records: Record<string, DocRecord>): void {
    writeRecordFile(recordPath(file), JSON.stringify(records, null, 2));
  }

  /** Upsert a record, but pay nothing when it is already current — the signature gate makes Stop-time
   * documentation idempotent and cheap (only new or changed symbols cost a model call). */
  async function document(file: string, symbol: string): Promise<DocRecord> {
    const source = (() => {
      try {
        return readFile(file);
      } catch {
        return "";
      }
    })();
    const records = readRecords(file);
    const prev = records[symbol];
    const sig = extractSignature(source, symbol);
    if (prev && sig !== null && prev.signature === sig) return prev; // already current → no cost
    const fresh = await generateRecord(file, symbol, source);
    records[symbol] = fresh;
    writeRecords(file, records);
    return fresh;
  }

  return {
    inlineDocs,

    async whatCodeDoes(file: string, symbol: string): Promise<WhatCodeDoes> {
      return buildWhatCodeDoes(symbol, codeContext(file));
    },

    async refresh(changedFiles: string[]): Promise<void> {
      for (const file of changedFiles) {
        const records = readRecords(file);
        const symbols = Object.keys(records);
        if (symbols.length === 0) continue; // nothing documented here → nothing to stale
        let source = "";
        try {
          source = readFile(file);
        } catch {
          continue; // file gone; leave its record until an explicit cleanup
        }
        let changed = false;
        for (const symbol of symbols) {
          const sig = extractSignature(source, symbol);
          if (sig !== null && sig !== records[symbol]!.signature) {
            records[symbol] = await generateRecord(file, symbol, source);
            changed = true;
          }
        }
        if (changed) writeRecords(file, records);
      }
    },

    document,
  };
}
