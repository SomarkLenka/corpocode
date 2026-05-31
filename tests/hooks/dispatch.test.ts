import { describe, it, expect, vi } from "vitest";
import { dispatchHook, type DispatchDeps } from "../../src/hooks/dispatch";
import { defaultConfig } from "../../src/config/load";
import type { HandlerMap } from "../../src/hooks/handlers";
import type { HookContext } from "../../src/hooks/context";

const fakeCtx = {} as unknown as HookContext;

const deps = (handlers: Partial<HandlerMap>): DispatchDeps => ({
  loadConfig: () => defaultConfig(),
  makeContext: () => fakeCtx,
  handlers,
});

const validPrompt = JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: "/repo", prompt: "hello" });

describe("dispatchHook (fail-open safety)", () => {
  it("routes a valid UserPromptSubmit to its handler", async () => {
    const handler = vi.fn(async () => ({ hookEventName: "UserPromptSubmit", additionalContext: "hi" }));
    const out = await dispatchHook("UserPromptSubmit", validPrompt, deps({ UserPromptSubmit: handler }));
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("hi");
  });

  it("stamps hookEventName whenever hookSpecificOutput is present (a handler can't omit it)", async () => {
    // A PreToolUse handler that returns a permission decision but FORGETS hookEventName — Claude Code
    // rejects output whose hookSpecificOutput lacks hookEventName, so the dispatcher must add it.
    const handler = vi.fn(async () => ({ permissionDecision: "deny" as const, permissionDecisionReason: "nope" }));
    const preTool = JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    const out = JSON.parse(await dispatchHook("PreToolUse", preTool, deps({ PreToolUse: handler })));
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("keeps the empty response as {} (no hookSpecificOutput stamped onto nothing)", async () => {
    const handler = vi.fn(async () => ({})); // a no-op fail-open response
    const preTool = JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name: "Read", tool_input: {} });
    expect(await dispatchHook("PreToolUse", preTool, deps({ PreToolUse: handler }))).toBe("{}");
  });

  it("returns empty {} for an unknown hook name", async () => {
    expect(await dispatchHook("Nope", validPrompt, deps({}))).toBe("{}");
  });

  it("returns empty {} for malformed JSON (controlled exit, no throw)", async () => {
    expect(await dispatchHook("UserPromptSubmit", "{ not json", deps({}))).toBe("{}");
  });

  it("returns empty {} for an invalid envelope and does not call the handler", async () => {
    const handler = vi.fn(async () => ({}));
    const out = await dispatchHook(
      "UserPromptSubmit",
      JSON.stringify({ session_id: "s", transcript_path: "/t" }), // no prompt
      deps({ UserPromptSubmit: handler }),
    );
    expect(out).toBe("{}");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails open when a handler throws (never breaks the host turn)", async () => {
    const handler = async (): Promise<never> => {
      throw new Error("boom");
    };
    expect(await dispatchHook("UserPromptSubmit", validPrompt, deps({ UserPromptSubmit: handler }))).toBe("{}");
  });

  it("returns empty {} when no handler is registered for a valid hook", async () => {
    const stop = JSON.stringify({ session_id: "s", transcript_path: "/t" });
    expect(await dispatchHook("Stop", stop, deps({}))).toBe("{}");
  });

  it("fails open when a handler hangs past the timeout budget", async () => {
    const hang = (): Promise<never> => new Promise(() => {}); // never resolves
    const out = await dispatchHook("UserPromptSubmit", validPrompt, {
      ...deps({ UserPromptSubmit: hang }),
      hookTimeoutMs: 20,
    });
    expect(out).toBe("{}");
  });
});
