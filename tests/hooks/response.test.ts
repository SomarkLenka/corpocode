import { describe, it, expect } from "vitest";
import { buildResponse, tagged, joinBlocks, emptyResponse, TAGS } from "../../src/hooks/response";

describe("response builder", () => {
  it("emptyResponse is the literal {}", () => {
    expect(emptyResponse()).toBe("{}");
  });

  it("places additionalContext under hookSpecificOutput", () => {
    const out = JSON.parse(buildResponse({ hookEventName: "UserPromptSubmit", additionalContext: "ctx" }));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toBe("ctx");
  });

  it("builds a permission decision with reason", () => {
    const out = JSON.parse(
      buildResponse({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "nope" }),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("nope");
  });

  it("builds a block decision at the top level", () => {
    const out = JSON.parse(buildResponse({ decision: "block", reason: "bad", continue: false, stopReason: "x" }));
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("bad");
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe("x");
  });

  it("omits an empty hookSpecificOutput", () => {
    expect(buildResponse({})).toBe("{}");
  });

  it("tags content and joins blocks, dropping empties", () => {
    expect(tagged("t", "c")).toBe("<t>\nc\n</t>");
    const joined = joinBlocks([{ tag: TAGS.recommendation, content: "a" }, null, "b"]);
    expect(joined).toContain("<middle-management recommendation>");
    expect(joined).toContain("b");
  });
});
