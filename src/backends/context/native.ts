// Native ContextStore (Phase 5) — a true drop-in for the OpenViking adapter, behind the identical
// interface and passing the identical round-trip behaviors. No daemon, no port, no separate config: it
// is just a file the process opens. The defining feature OpenViking did with its own models — tiering
// content into L0/L1/L2 — the native store does through the SAME seams the rest of CorpoCode uses: a
// Provider-backed summarizer for the tiers and the Provider-backed embedder for semantic find. Both
// default to the dependency-free local implementations (matching the native memory store since Phase 1),
// so it works offline and a turn never blocks on a remote model.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { corpocodeHome } from "../../config/paths";
import { embedText, cosineSimilarity } from "../memory/embedder";
import type { ContextStore, FindResult, Resource, ResourceKind, Tier, TreeEntry } from "./types";

/** Produces the shorter views of a resource. Provider-backed in production; truncation offline. */
export interface Summarizer {
  summarize(text: string, target: "summary" | "one-line"): Promise<string>;
}

interface StoredResource {
  uri: string;
  kind: ResourceKind;
  l0: string;
  l1: string;
  l2: string;
  embedding: number[];
}

export interface ContextStorage {
  read(): Record<string, StoredResource>;
  write(all: Record<string, StoredResource>): void;
}

export interface NativeContextOptions {
  env?: NodeJS.ProcessEnv;
  storage?: ContextStorage;
  summarizer?: Summarizer;
  embed?: (text: string) => Promise<number[]>;
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** The offline default: L1 is the first half, L0 the first line capped — monotonic tier sizes, no model. */
function truncationSummarizer(): Summarizer {
  return {
    async summarize(text, target) {
      if (target === "one-line") return (text.split("\n")[0] ?? "").slice(0, 40);
      return text.slice(0, Math.ceil(text.length / 2));
    },
  };
}

function fileStorage(path: string): ContextStorage {
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredResource>;
      } catch {
        return {}; // missing/corrupt store reads as empty, never throws
      }
    },
    write(all) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(all));
    },
  };
}

function tierContent(r: StoredResource, tier: Tier): string {
  return tier === "L0" ? r.l0 : tier === "L1" ? r.l1 : r.l2;
}

export function createNativeContextStore(opts: NativeContextOptions = {}): ContextStore {
  const storage = opts.storage ?? fileStorage(join(corpocodeHome(opts.env), "context", "native.json"));
  const summarizer = opts.summarizer ?? truncationSummarizer();
  const embed = opts.embed ?? ((text: string) => Promise.resolve(embedText(text)));

  const toResource = (r: StoredResource, tier: Tier, score?: number): Resource => {
    const content = tierContent(r, tier);
    return { uri: r.uri, kind: r.kind, tier, content, tokens: estTokens(content), ...(score !== undefined ? { score } : {}) };
  };

  return {
    id: "native",

    async write(uri: string, content: string, o?: { kind?: ResourceKind }): Promise<void> {
      // L2 is the full text; L1 and L0 are progressively shorter views; the embedding makes find semantic.
      const l1 = await summarizer.summarize(content, "summary");
      const l0 = await summarizer.summarize(l1, "one-line");
      const embedding = await embed(l1);
      const all = storage.read();
      all[uri] = { uri, kind: o?.kind ?? "memory", l0, l1, l2: content, embedding };
      storage.write(all);
    },

    async find(query: string, o: { tier: Tier; limit: number; root?: string }): Promise<FindResult> {
      const all = storage.read();
      const qv = await embed(query);
      const records = Object.values(all).filter((r) => (o.root ? r.uri.startsWith(o.root) : true));
      const ranked = records
        .map((r) => ({ r, score: cosineSimilarity(qv, r.embedding) }))
        .sort((a, b) => b.score - a.score || a.r.uri.localeCompare(b.r.uri))
        .slice(0, o.limit);
      return {
        query,
        tier: o.tier,
        resources: ranked.map(({ r, score }) => toResource(r, o.tier, score)),
        trajectory: ["semantic", query],
      };
    },

    async load(uri: string, tier: Tier): Promise<string> {
      const r = storage.read()[uri];
      return r ? tierContent(r, tier) : ""; // a miss is empty, mirroring the adapter's 404 behavior
    },

    async tree(uri: string, o?: { depth?: number }): Promise<TreeEntry[]> {
      void o?.depth; // flat store: depth is advisory; every matching uri under the prefix is returned
      const all = storage.read();
      return Object.values(all)
        .filter((r) => r.uri.startsWith(uri))
        .sort((a, b) => a.uri.localeCompare(b.uri))
        .map((r) => ({ uri: r.uri, kind: r.kind, abstract: r.l0, childCount: 0 }));
    },

    async grep(pattern: string, o?: { root?: string }): Promise<Resource[]> {
      const all = storage.read();
      return Object.values(all)
        .filter((r) => (o?.root ? r.uri.startsWith(o.root) : true) && r.l2.includes(pattern))
        .sort((a, b) => a.uri.localeCompare(b.uri))
        .map((r) => toResource(r, "L2"));
    },

    async start(): Promise<void> {
      // "Starting" is just ensuring the store's home exists — there is no daemon to launch.
      mkdirSync(join(corpocodeHome(opts.env), "context"), { recursive: true });
    },

    async health(): Promise<{ up: boolean; version?: string }> {
      return { up: true, version: "native-1" }; // an in-process store is up whenever the process is
    },

    async ping(): Promise<boolean> {
      return true;
    },
  };
}
