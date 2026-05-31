import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPlatform,
  registerJsonHooks,
  unregisterJsonHooks,
  type HookEvent,
} from "../../src/install/platform";
import { detectPlatforms, getPlatformAdapter, PLATFORM_ADAPTERS } from "../../src/install/platform-registry";
import { serializeForPlatform } from "../../src/hooks/platform-output";

type HG = { matcher?: string; hooks: { type: string; command: string }[] };
const hooksOf = (s: Record<string, unknown>): Record<string, HG[]> => s.hooks as Record<string, HG[]>;

describe("platform adapters", () => {
  it("declares a full event set for codex and reduced sets for cursor/gemini-cli (graceful degradation)", () => {
    expect(PLATFORM_ADAPTERS.codex.hookEvents()).toContain("PreToolUse");
    expect(PLATFORM_ADAPTERS.cursor.hookEvents()).not.toContain("PreToolUse");
    expect(PLATFORM_ADAPTERS["gemini-cli"].hookEvents()).toEqual(["UserPromptSubmit", "Stop"]);
  });

  it("registerJsonHooks adds our group and is idempotent (re-register replaces, never duplicates)", () => {
    const specs = [{ event: "UserPromptSubmit" as HookEvent }];
    const once = registerJsonHooks({}, specs, () => "corpocode hook UserPromptSubmit");
    const twice = registerJsonHooks(once, specs, () => "corpocode hook UserPromptSubmit");
    expect(hooksOf(twice).UserPromptSubmit).toHaveLength(1);
  });

  it("preserves a foreign hook group on register and removes only ours on unregister", () => {
    const foreign = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "someone-else" }] }] } };
    const reg = registerJsonHooks(foreign, [{ event: "UserPromptSubmit" }], () => "corpocode hook X");
    expect(hooksOf(reg).UserPromptSubmit).toHaveLength(2);
    const unreg = unregisterJsonHooks(reg);
    expect(hooksOf(unreg).UserPromptSubmit).toHaveLength(1);
    expect(hooksOf(unreg).UserPromptSubmit[0]!.hooks[0]!.command).toBe("someone-else");
  });

  it("responseEnvelope shapes differ per platform (the one axis we model)", () => {
    const out = { additionalContext: "HELLO" };
    expect(serializeForPlatform(out, "claude-code")).toContain("hookSpecificOutput");
    expect(JSON.parse(serializeForPlatform(out, "codex")).additional_context).toBe("HELLO");
    expect(JSON.parse(serializeForPlatform(out, "opencode")).context).toBe("HELLO");
    expect(JSON.parse(serializeForPlatform(out, "cursor")).additionalContext).toBe("HELLO");
    expect(JSON.parse(serializeForPlatform(out, "gemini-cli")).systemContext).toBe("HELLO");
  });

  it("installPlatform writes shims only for the supported events and stamps the platform marker", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-plat-"));
    try {
      const env = { GEMINI_CONFIG_DIR: join(root, "gem") } as NodeJS.ProcessEnv;
      const res = installPlatform(PLATFORM_ADAPTERS["gemini-cli"], { env, assetsRoot: root, os: "linux" });
      const shimDir = join(root, "gem", "hooks");
      expect(existsSync(join(shimDir, "corpocode-UserPromptSubmit.sh"))).toBe(true);
      expect(existsSync(join(shimDir, "corpocode-Stop.sh"))).toBe(true);
      expect(existsSync(join(shimDir, "corpocode-PreToolUse.sh"))).toBe(false); // unsupported → not installed
      expect(res.events).toEqual(["UserPromptSubmit", "Stop"]);
      // The shim body carries the platform marker so the dispatcher emits the right envelope.
      expect(readFileSync(join(shimDir, "corpocode-UserPromptSubmit.sh"), "utf8")).toContain("--platform gemini-cli");
      const settings = JSON.parse(readFileSync(join(root, "gem", "hooks.json"), "utf8"));
      expect(hooksOf(settings).UserPromptSubmit[0]!.hooks[0]!.command).toContain("corpocode-UserPromptSubmit.sh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectPlatforms finds a platform whose config dir exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-det-"));
    try {
      const detected = detectPlatforms({ CODEX_HOME: root } as NodeJS.ProcessEnv);
      expect(detected.some((a) => a.id === "codex")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("getPlatformAdapter returns null for an unknown id", () => {
    expect(getPlatformAdapter("nope")).toBeNull();
  });
});
