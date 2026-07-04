import { describe, it, expect } from "vitest";
import { createFlowParser, RULE } from "../../src/monitor/flow-parse";

// Reproduce the on-disk block shape that src/log/flow.ts writes, so the parser is tested against
// exactly what it will see in the wild.
function block(opts: {
  hook: string;
  detail?: string;
  ts: string;
  session: string;
  body?: string;
}): string {
  const detailPart = opts.detail ? `  ·  ${opts.detail}` : "";
  const head = `${RULE}\n▶ ${opts.hook}${detailPart}  ·  ${opts.ts}  ·  session ${opts.session}\n${RULE}`;
  return `\n${head}\n\n╶ transcript (1 entry) ╴\n\n  ${opts.body ?? "hello"}\n\n╶ hook output ╴\n\n  (no output)\n`;
}

describe("flow parser", () => {
  it("parses a single complete block's header fields", () => {
    const parser = createFlowParser();
    const blocks = parser.push(
      block({ hook: "PreToolUse", detail: "Edit file_path: a.ts", ts: "2026-06-17T10:00:00.000Z", session: "abcd1234" }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      hookName: "PreToolUse",
      detail: "Edit file_path: a.ts",
      ts: "2026-06-17T10:00:00.000Z",
      sessionId: "abcd1234",
    });
    expect(blocks[0]!.text).toContain("▶ PreToolUse");
  });

  it("treats a missing detail segment as undefined", () => {
    const parser = createFlowParser();
    const [b] = parser.push(block({ hook: "SessionStart", ts: "2026-06-17T10:00:00.000Z", session: "ses1" }));
    expect(b!.hookName).toBe("SessionStart");
    expect(b!.detail).toBeUndefined();
    expect(b!.sessionId).toBe("ses1");
  });

  it("emits multiple concatenated blocks in order", () => {
    const parser = createFlowParser();
    const text =
      block({ hook: "PreToolUse", ts: "2026-06-17T10:00:00.000Z", session: "s1" }) +
      block({ hook: "PostToolUse", ts: "2026-06-17T10:00:01.000Z", session: "s1" });
    const blocks = parser.push(text);
    expect(blocks.map((b) => b.hookName)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("buffers an incomplete trailing block until its header completes", () => {
    const parser = createFlowParser();
    const full = block({ hook: "Stop", ts: "2026-06-17T10:00:02.000Z", session: "s2" });
    // Split mid-header (before the closing rule line) so the trailing block is not yet complete.
    const cut = full.indexOf("▶ Stop") + 4;
    const first = parser.push(full.slice(0, cut));
    expect(first).toHaveLength(0); // header not finished → nothing emitted yet
    const rest = parser.push(full.slice(cut));
    expect(rest.map((b) => b.hookName)).toEqual(["Stop"]);
  });

  it("emits a completed earlier block while buffering a partial later one", () => {
    const parser = createFlowParser();
    const a = block({ hook: "PreToolUse", ts: "2026-06-17T10:00:00.000Z", session: "s3" });
    const b = block({ hook: "PostToolUse", ts: "2026-06-17T10:00:01.000Z", session: "s3" });
    const bCut = b.indexOf("▶ PostToolUse") + 4; // partial header of b
    const out1 = parser.push(a + b.slice(0, bCut));
    expect(out1.map((x) => x.hookName)).toEqual(["PreToolUse"]); // a complete, b buffered
    const out2 = parser.push(b.slice(bCut));
    expect(out2.map((x) => x.hookName)).toEqual(["PostToolUse"]);
  });

  it("returns nothing for text with no block start marker yet", () => {
    const parser = createFlowParser();
    expect(parser.push("some preamble with no rule\n")).toHaveLength(0);
  });
});
