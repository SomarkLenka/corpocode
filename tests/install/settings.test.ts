import { describe, it, expect } from "vitest";
import {
  registerHooks,
  unregisterHooks,
  isCorpocodeGroup,
  hasCorpocodeHooks,
  HOOK_SPECS,
  type Settings,
} from "../../src/install/settings";

const cmd = (name: string): string => `/home/.claude/hooks/corpocode-${name}.sh`;

describe("settings hook registration", () => {
  it("registers every event and preserves unrelated settings and foreign hooks", () => {
    const settings: Settings = {
      model: "opus",
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] },
    };
    const next = registerHooks(settings, cmd);
    expect(next.model).toBe("opus");
    expect(next.hooks!.UserPromptSubmit).toHaveLength(2); // foreign + ours
    expect(next.hooks!.PreToolUse![0]!.matcher).toBe("*");
    expect(next.hooks!.PostToolUse![0]!.matcher).toBe("Write|Edit");
    expect(hasCorpocodeHooks(next)).toBe(true);
  });

  it("is idempotent — re-registering does not duplicate our groups", () => {
    const once = registerHooks({}, cmd);
    const twice = registerHooks(once, cmd);
    for (const spec of HOOK_SPECS) {
      expect(twice.hooks![spec.name]!.filter(isCorpocodeGroup)).toHaveLength(1);
    }
  });

  it("unregister removes only corpocode groups", () => {
    const withForeign = registerHooks(
      { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "keep-me" }] }] } },
      cmd,
    );
    const cleaned = unregisterHooks(withForeign);
    expect(hasCorpocodeHooks(cleaned)).toBe(false);
    expect(cleaned.hooks!.UserPromptSubmit).toHaveLength(1);
    expect(cleaned.hooks!.UserPromptSubmit![0]!.hooks[0]!.command).toBe("keep-me");
    expect(cleaned.hooks!.PreToolUse).toBeUndefined();
  });
});
