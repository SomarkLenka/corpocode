import { describe, it, expect } from "vitest";
import { applyEffort } from "../../src/providers/effort";
import type { ChatInput } from "../../src/providers/types";

const base: ChatInput = { system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 500 };

describe("applyEffort", () => {
  it("scales the token budget up for high effort and down for minimal", () => {
    expect(applyEffort(base, "high").maxTokens).toBe(800);
    expect(applyEffort(base, "minimal").maxTokens).toBe(300);
    expect(applyEffort(base, "medium").maxTokens).toBe(500);
  });

  it("leaves the input untouched when effort is undefined", () => {
    expect(applyEffort(base, undefined)).toBe(base);
  });

  it("never drops below the token floor", () => {
    expect(applyEffort({ ...base, maxTokens: 10 }, "minimal").maxTokens).toBe(64);
  });

  it("defaults the base budget when maxTokens is unset", () => {
    expect(applyEffort({ system: "s", messages: [] }, "high").maxTokens).toBe(800); // 500 default × 1.6
  });
});
