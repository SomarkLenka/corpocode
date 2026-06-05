import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_SPECS } from "../../src/install/settings";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

describe("plugin payload files", () => {
  it("plugin.json carries the required identity fields", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json"));
    expect(plugin.name).toBe("corpocode");
    expect(typeof plugin.version).toBe("string");
    expect(typeof plugin.description).toBe("string");
  });

  it("hooks.json declares every HOOK_SPEC via ${CLAUDE_PLUGIN_ROOT} and cannot drift from it", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json"));
    // The plugin manifest (what Claude Code reads) must match the install spec exactly, so the two
    // registration paths — plugin and npm/native — never diverge on which surfaces are attached.
    expect(Object.keys(hooks.hooks).sort()).toEqual(HOOK_SPECS.map((s) => s.name).sort());
    for (const spec of HOOK_SPECS) {
      const group = hooks.hooks[spec.name][0];
      expect(group.hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(group.hooks[0].command).toContain(`hook ${spec.name}`);
      expect(group.matcher).toBe(spec.matcher); // both undefined when the spec has no matcher
    }
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("*");
    expect(hooks.hooks.PostToolUse[0].matcher).toBe("*"); // broadened so the flow log sees every tool result
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
    // Frontmatter name matches the dir so it registers as /corpocode:corpocode-setup (not /corpocode:setup).
    expect(read("skills", "corpocode-setup", "SKILL.md")).toContain("name: corpocode-setup");
  });
});
