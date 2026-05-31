// Doc generator — proves the Phase 3 §3 Definition of Done (master spec §14): it writes inline docs
// plus a what-code-does record beside the code, resolves `touches` from the KnowledgeGraph (not the
// model), refreshes the record when a signature edit stales it, and pays no model call when a record
// is already current. The provider and graph are faked so the test runs fully offline.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createDocGenerator } from "../../src/docs/generator";
import type { Provider, ChatInput, ChatOutput } from "../../src/providers/types";
import type { KnowledgeGraph, GraphNode, Neighborhood } from "../../src/backends/graph/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// A superset JSON that satisfies every facet schema at once (each Zod schema picks its own fields),
// so one canned response drives the whole fan-out while still proving each field is wired through.
const FACET_JSON = JSON.stringify({
  items: ["something"],
  params: "a: number",
  structure: "scalar",
  mutabilityIfChanged: "callers break",
  how: "adds one",
  purpose: "increment",
  considerations: "none",
});

function fakeProvider(): Provider & { calls: number } {
  const p = {
    id: "anthropic" as const,
    model: "fake",
    modelTier: "fast" as const,
    calls: 0,
    async chat(input: ChatInput): Promise<ChatOutput> {
      p.calls++;
      const text = input.responseFormat === "json" ? FACET_JSON : "Increments the counter.";
      return {
        text,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        providerId: "anthropic",
        model: "fake",
        finishReason: "stop",
      };
    },
    async ping(): Promise<boolean> {
      return true;
    },
  };
  return p;
}

// A graph that returns one neighbor with a path — so `touches` is graph-resolved, never guessed.
const fakeGraph: KnowledgeGraph = {
  id: "fake",
  async scoreFiles() {
    return [];
  },
  async getNode(name: string): Promise<GraphNode | null> {
    return { id: `node:${name}`, name, kind: "function" };
  },
  async getNeighbors(): Promise<Neighborhood> {
    return {
      center: { id: "node:x", name: "x", kind: "function" },
      nodes: [{ id: "node:dep", name: "dep", kind: "function", path: "src/dep.ts" }],
      edges: [],
      depth: 1,
    };
  },
  async findPath() {
    return null;
  },
  async query() {
    return { nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false };
  },
  async ensureBuilt() {},
  async refresh() {},
  async ping() {
    return true;
  },
};

function setup(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-docs-"));
  dirs.push(dir);
  const file = join(dir, "src", "counter.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export function increment(a: number): number {\n  return a + 1;\n}\n");
  return { dir, file };
}

const recordOf = (file: string) => JSON.parse(readFileSync(`${file}.cc-doc.json`, "utf8"));

describe("DocGenerator", () => {
  it("writes inline docs + a what-code-does record beside the code, with graph-resolved touches", async () => {
    const { file } = setup();
    const provider = fakeProvider();
    const gen = createDocGenerator({ provider, graph: fakeGraph, repoRoot: dirname(file) });

    const rec = await gen.document(file, "increment");

    expect(existsSync(`${file}.cc-doc.json`)).toBe(true); // persisted beside the source
    expect(rec.inlineDocs).toBe("Increments the counter.");
    expect(rec.touches).toEqual(["src/dep.ts"]); // from the graph, not the model
    expect(rec.impacts).toEqual(["something"]);
    expect(rec.input.params).toBe("a: number");
    expect(rec.signature).toContain("increment(a: number)");

    const onDisk = recordOf(file);
    expect(onDisk.increment.inlineDocs).toBe("Increments the counter.");
  });

  it("refreshes the record when a signature edit stales it — in the same change", async () => {
    const { file } = setup();
    let clock = 1000;
    const provider = fakeProvider();
    const gen = createDocGenerator({
      provider,
      graph: fakeGraph,
      repoRoot: dirname(file),
      now: () => clock,
    });

    await gen.document(file, "increment");
    const firstSig = recordOf(file).increment.signature;
    const afterCreate = provider.calls;
    expect(afterCreate).toBeGreaterThan(0);

    // Re-documenting an unchanged symbol pays nothing — the signature gate short-circuits.
    await gen.document(file, "increment");
    expect(provider.calls).toBe(afterCreate);

    // Edit the signature, then refresh: the record must regenerate against the new declaration.
    clock = 2000;
    writeFileSync(file, "export function increment(a: number, step: number): number {\n  return a + step;\n}\n");
    await gen.refresh([file]);

    const updated = recordOf(file).increment;
    expect(updated.signature).toContain("step: number"); // regenerated against the edit
    expect(updated.signature).not.toBe(firstSig);
    expect(updated.generatedAt).toBe(2000); // a fresh generation, not the stale one
    expect(provider.calls).toBeGreaterThan(afterCreate); // refresh did real work
  });

  it("refresh is a no-op for a file with no record and never throws on a missing file", async () => {
    const { file } = setup();
    const provider = fakeProvider();
    const gen = createDocGenerator({ provider, graph: fakeGraph, repoRoot: dirname(file) });

    await gen.refresh([file]); // no record yet → nothing to do
    expect(provider.calls).toBe(0);
    expect(existsSync(`${file}.cc-doc.json`)).toBe(false);

    await expect(gen.refresh([join(dirname(file), "ghost.ts")])).resolves.toBeUndefined();
  });
});
