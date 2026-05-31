import { describe, it, expect } from "vitest";
import { computeWindow } from "../../src/compactor/sliding-window";
import type { TranscriptMessage } from "../../src/compactor/types";

const m = (role: TranscriptMessage["role"], content: string): TranscriptMessage => ({ role, content });

const TRANSCRIPT: TranscriptMessage[] = [
  m("user", "old1"),
  m("assistant", "old2"),
  m("tool", "oldtool"),
  m("user", "recent1"),
  m("assistant", "recent2"),
  m("tool", "recenttool"),
];

describe("sliding window", () => {
  it("preserves the most recent turns and tool outputs, compacts the rest", () => {
    const { preserved, compactable } = computeWindow(TRANSCRIPT, { preserved_turns: 2, preserved_tool_outputs: 1 });
    const preservedText = preserved.map((x) => x.content);
    const compactableText = compactable.map((x) => x.content);
    expect(preservedText).toContain("recent1");
    expect(preservedText).toContain("recent2");
    expect(preservedText).toContain("recenttool");
    expect(compactableText).toContain("old1");
    expect(compactableText).toContain("old2");
  });

  it("NEVER places a preserved turn into the compactable region", () => {
    const { preserved, compactable } = computeWindow(TRANSCRIPT, { preserved_turns: 2, preserved_tool_outputs: 1 });
    const compactableSet = new Set(compactable);
    for (const p of preserved) expect(compactableSet.has(p)).toBe(false);
  });

  it("compacts everything when nothing is preserved", () => {
    const { preserved, compactable } = computeWindow(TRANSCRIPT, { preserved_turns: 0, preserved_tool_outputs: 0 });
    expect(preserved).toHaveLength(0);
    expect(compactable).toHaveLength(TRANSCRIPT.length);
  });

  it("does not force preserving everything when there are no tool outputs", () => {
    const noTools = [m("user", "a"), m("assistant", "b"), m("user", "c"), m("assistant", "d")];
    const { preserved, compactable } = computeWindow(noTools, { preserved_turns: 1, preserved_tool_outputs: 4 });
    expect(preserved.map((x) => x.content)).toEqual(["d"]);
    expect(compactable.map((x) => x.content)).toEqual(["a", "b", "c"]);
  });
});
