import { describe, it, expect } from "vitest";
import { buildCliArgs } from "../../src/providers/anthropic-cli";

describe("claude-cli provider invocation args", () => {
  // Regression: the provider is used by every caretaker component (router/retrieval/filter/…) on every
  // hook. CorpoCode runs INSIDE a `claude` session, so a cheap-model call that spawns `claude` without
  // `--bare` re-fires CorpoCode's own hooks → unbounded recursion that hangs the hook (the symptom was
  // "fails to start cleanly" + a flood of SessionStart events). `--bare` (skip hooks/LSP/plugins) is the
  // mandatory recursion guard — the same one the agent backend already applies.
  it("includes --bare so a hook's cheap-model call never re-triggers CorpoCode's hooks", () => {
    expect(buildCliArgs("claude-haiku-4-5")).toContain("--bare");
  });

  it("is a one-shot JSON print call for the given model", () => {
    const args = buildCliArgs("claude-haiku-4-5");
    expect(args).toContain("--print");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-haiku-4-5"]));
  });
});
