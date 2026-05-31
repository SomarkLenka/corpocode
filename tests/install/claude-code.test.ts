import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCode } from "../../src/install/claude-code";

// Assets (agents/, skills/) live at the repo root, which is the vitest working directory.
const ASSETS = process.cwd();

describe("installClaudeCode", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-claude-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("dry-run plans changes without writing anything", () => {
    const res = installClaudeCode({ claudeHome: home, assetsRoot: ASSETS, platform: "linux", dryRun: true });
    expect(res.applied).toBe(false);
    expect(res.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(existsSync(join(home, "hooks"))).toBe(false);
  });

  it("writes shims, registers hooks, and copies the agent + skills (posix)", () => {
    installClaudeCode({ claudeHome: home, assetsRoot: ASSETS, platform: "linux" });
    expect(existsSync(join(home, "hooks", "corpocode-UserPromptSubmit.sh"))).toBe(true);
    expect(readFileSync(join(home, "hooks", "corpocode-PostToolUse.sh"), "utf8")).toContain(
      "corpocode hook PostToolUse",
    );
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("corpocode-UserPromptSubmit.sh");
    expect(existsSync(join(home, "agents", "haiku-helper.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "corpocode-router", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "corpocode-setup", "SKILL.md"))).toBe(true);
  });

  it("registers a powershell command and a .ps1 shim on win32", () => {
    installClaudeCode({ claudeHome: home, assetsRoot: ASSETS, platform: "win32" });
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("powershell");
    expect(existsSync(join(home, "hooks", "corpocode-UserPromptSubmit.ps1"))).toBe(true);
  });

  it("is idempotent and preserves unrelated settings", () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ theme: "dark" }));
    installClaudeCode({ claudeHome: home, assetsRoot: ASSETS, platform: "linux" });
    installClaudeCode({ claudeHome: home, assetsRoot: ASSETS, platform: "linux" });
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1); // no duplication
  });
});
