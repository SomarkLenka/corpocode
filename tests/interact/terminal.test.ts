// The terminal Interactor, driven entirely over PassThrough pipes — no TTY, no real stdin. The
// load-bearing guarantees under test: ask() never throws, EOF resolves the declared default (or
// null ⇒ pause), and the rendering shows the pilot everything the recommendation was based on.
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createTerminalInteractor } from "../../src/interact/terminal";
import type { AxisFinding, Poll } from "../../src/interact/types";

function finding(axis: string, optionId: string, over: Partial<AxisFinding> = {}): AxisFinding {
  return { axis, optionId, summary: `${axis} impact`, severity: "info", ok: true, ...over };
}

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: "p1",
    concept: "storage",
    question: "Where does state live?",
    options: [
      { id: "a", label: "SQLite", description: "One file on disk.", findings: [finding("performance", "a"), finding("failure-modes", "a", { severity: "warn" })] },
      { id: "b", label: "Postgres", findings: [finding("performance", "b")], recommended: true },
    ],
    allowFreeText: true,
    allowDelegate: true,
    ...over,
  };
}

function surface() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { input, output, text: () => chunks.join("") };
}

describe("createTerminalInteractor — answering", () => {
  it("a number picks that option as the pilot's answer", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("2\n");
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", optionId: "b", source: "pilot" });
    await ix.close();
  });

  it('"d" delegates to the recommended option when delegation is allowed', async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("d\n");
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", optionId: "b", source: "delegated" });
    await ix.close();
  });

  it('"d" without a recommendation delegates to the default option', async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    const p = poll({ defaultOptionId: "a" });
    p.options = p.options.map((o) => ({ ...o, recommended: undefined }));
    s.input.write("d\n");
    await expect(ix.ask(p)).resolves.toEqual({ pollId: "p1", optionId: "a", source: "delegated" });
    await ix.close();
  });

  it("free text answers freeText when the poll allows it", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("keep it in memory, honestly\n");
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", freeText: "keep it in memory, honestly", source: "pilot" });
    await ix.close();
  });

  it("re-prompts on free text when the poll forbids it, then accepts a number", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("something rambly\n1\n");
    await expect(ix.ask(poll({ allowFreeText: false }))).resolves.toEqual({ pollId: "p1", optionId: "a", source: "pilot" });
    await ix.close();
  });

  it('"d" is plain free text when delegation is off (the poll allows free text)', async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("d\n");
    await expect(ix.ask(poll({ allowDelegate: false }))).resolves.toEqual({ pollId: "p1", freeText: "d", source: "pilot" });
    await ix.close();
  });

  it("re-prompts on an out-of-range number", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("7\n2\n");
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", optionId: "b", source: "pilot" });
    await ix.close();
  });
});

describe("createTerminalInteractor — dead channel (the fail-open edge)", () => {
  it("EOF resolves the declared default with source 'default'", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.end();
    await expect(ix.ask(poll({ defaultOptionId: "a" }))).resolves.toEqual({ pollId: "p1", optionId: "a", source: "default" });
    await ix.close();
  });

  it("EOF with no default resolves null — the caller pauses the run", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.end();
    await expect(ix.ask(poll())).resolves.toBeNull();
    await ix.close();
  });

  it("EOF arriving mid-ask (after the render) still resolves the default", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    const pending = ix.ask(poll({ defaultOptionId: "b" }));
    s.input.end();
    await expect(pending).resolves.toEqual({ pollId: "p1", optionId: "b", source: "default" });
    await ix.close();
  });

  it("close() is idempotent and asks after close resolve the default", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    await ix.close();
    await ix.close();
    await expect(ix.ask(poll({ defaultOptionId: "a" }))).resolves.toEqual({ pollId: "p1", optionId: "a", source: "default" });
  });
});

describe("createTerminalInteractor — rendering", () => {
  it("renders teaching first, then the question, numbered options, findings, and the recommendation", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    s.input.write("1\n");
    await ix.ask(poll({ teaching: { concept: "storage", body: "State outlives the process; pick where it sleeps." } }));
    const out = s.text();

    expect(out).toContain("teaching: storage");
    expect(out).toContain("State outlives the process; pick where it sleeps.");
    expect(out.indexOf("teaching: storage")).toBeLessThan(out.indexOf("Where does state live?"));
    expect(out.indexOf("Where does state live?")).toBeLessThan(out.indexOf("1. SQLite"));
    expect(out).toContain("2. Postgres  (recommended)");
    expect(out).toContain("One file on disk.");
    // The findings table is aligned: axis padded to the widest axis, severity in its own column.
    expect(out).toContain("performance    info  performance impact");
    expect(out).toContain("failure-modes  warn  failure-modes impact");
    expect(out).toContain('pick 1-2, "d" to delegate, or type your answer');
    await ix.close();
  });

  it("renders a failed axis as unanalyzed, never as a confident finding", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    const p = poll();
    p.options[0].findings = [finding("idiom", "a", { ok: false })];
    s.input.write("1\n");
    await ix.ask(p);
    expect(s.text()).toContain("unanalyzed");
    expect(s.text()).not.toContain("idiom impact");
    await ix.close();
  });

  it("say() writes the block; a broken output stream never throws", async () => {
    const s = surface();
    const ix = createTerminalInteractor({ input: s.input, output: s.output });
    ix.say("section api-spec: complete");
    expect(s.text()).toContain("section api-spec: complete");
    s.output.destroy();
    expect(() => ix.say("after death")).not.toThrow();
    await ix.close();
  });
});
