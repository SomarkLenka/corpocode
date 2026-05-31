import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

describe("plugin payload files", () => {
  it("plugin.json carries the required identity fields", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    expect(plugin.name).toBe("corpocode");
    expect(typeof plugin.version).toBe("string");
    expect(typeof plugin.description).toBe("string");
  });

  it("hooks.json declares the four Phase 1 hooks via ${CLAUDE_PLUGIN_ROOT}", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json"));
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook UserPromptSubmit");
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("*");
    expect(hooks.hooks.PostToolUse[0].matcher).toBe("Write|Edit");
  });

  it("marketplace.json installs the plugin from an HTTPS git url (no SSH, no npm needed)", () => {
    const market = JSON.parse(read(".claude-plugin", "marketplace.json"));
    expect(market.name).toBe("corpocode");
    expect(market.plugins[0].source.source).toBe("url");
    // HTTPS so the clone never falls back to git@github.com SSH (which needs a key).
    expect(market.plugins[0].source.url).toBe("https://github.com/SomarkLenka/corpocode.git");
  });

  it("agent and skills ship with the expected frontmatter names", () => {
    expect(read("agents", "haiku-helper.md")).toContain("name: haiku-helper");
    expect(read("skills", "corpocode-router", "SKILL.md")).toContain("name: corpocode-router");
    expect(read("skills", "corpocode-setup", "SKILL.md")).toContain("name: setup");
  });
});
