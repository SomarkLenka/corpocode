import { describe, it, expect } from "vitest";
import { userPromptSubmitSchema, preToolUseSchema, isHookName } from "../../src/hooks/envelope";

describe("hook envelopes", () => {
  it("parses a valid UserPromptSubmit and keeps unknown fields (forward-compat)", () => {
    const e = userPromptSubmitSchema.parse({
      session_id: "s",
      transcript_path: "/t",
      prompt: "hi",
      future_field: "keep",
    });
    expect(e.prompt).toBe("hi");
    expect((e as Record<string, unknown>).future_field).toBe("keep");
  });

  it("rejects a UserPromptSubmit without a prompt", () => {
    expect(userPromptSubmitSchema.safeParse({ session_id: "s", transcript_path: "/t" }).success).toBe(false);
  });

  it("defaults tool_input to an empty object", () => {
    const e = preToolUseSchema.parse({ session_id: "s", transcript_path: "/t", tool_name: "Bash" });
    expect(e.tool_input).toEqual({});
  });

  it("isHookName recognizes known hooks only", () => {
    expect(isHookName("UserPromptSubmit")).toBe(true);
    expect(isHookName("PostToolUse")).toBe(true);
    expect(isHookName("Nope")).toBe(false);
    expect(isHookName("toString")).toBe(false); // not fooled by prototype keys
  });
});
