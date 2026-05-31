// The deterministic gate: it backs up each skill/agent, rewrites its description in place to the gating
// line + marker, catalogs the original, is idempotent, skips CorpoCode's own plugin, self-heals after a
// plugin overwrite, and restores byte-for-byte. All real-fs over temp dirs.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoots, gateToolbox, restoreToolbox } from "../../src/toolbox/gate";
import { parseToolboxFrontmatter } from "../../src/toolbox/frontmatter";
import { loadCatalog } from "../../src/toolbox/catalog";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeSkill(dir: string, name: string, description: string): string {
  const p = join(dir, "skills", name, "SKILL.md");
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(p, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody\n`);
  return p;
}

function setupClaudeHome(): string {
  const home = tmp("cc-claude-");
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", "foo.md"), "---\nname: foo\ndescription: Use foo when doing X.\nmodel: haiku\n---\n# Foo\nbody\n");
  writeSkill(home, "bar", "A bar skill for Y tasks.");
  // a plugin-cache skill (should be gated) and CorpoCode's own plugin (should be skipped)
  const pluginSkills = join(home, "plugins", "cache", "mkt", "someplugin", "skills", "baz");
  mkdirSync(pluginSkills, { recursive: true });
  writeFileSync(join(pluginSkills, "SKILL.md"), "---\nname: baz\ndescription: Baz does Z.\n---\nbody\n");
  const ownSkills = join(home, "plugins", "cache", "claude-plugins-official", "corpocode", "skills", "corpocode-router");
  mkdirSync(ownSkills, { recursive: true });
  writeFileSync(join(ownSkills, "SKILL.md"), "---\nname: corpocode-router\ndescription: Re-run the categorizer.\n---\nbody\n");
  return home;
}

function gate(home: string, restore: string, catalog: string) {
  return gateToolbox({ roots: defaultRoots({ claudeHome: home, includePlugins: true }), restoreDir: restore, catalogPath: catalog });
}

describe("toolbox gate", () => {
  it("gates user/project/plugin skills, skips CorpoCode's own, and catalogs originals", () => {
    const home = setupClaudeHome();
    const restore = tmp("cc-restore-");
    const catalog = join(tmp("cc-cat-"), "catalog.json");

    const summary = gate(home, restore, catalog);
    expect(summary.gated).toBe(3); // foo, bar, baz (not corpocode-router)

    // foo.md: description replaced + marker, other keys + body preserved
    const foo = parseToolboxFrontmatter(readFileSync(join(home, "agents", "foo.md"), "utf8"));
    expect(foo.gated).toBe(true);
    expect(foo.description).toContain("Use ONLY when CorpoCode");
    expect(foo.name).toBe("foo");
    expect(foo.model).toBe("haiku");
    expect(readFileSync(join(home, "agents", "foo.md"), "utf8")).toContain("# Foo"); // body kept

    // CorpoCode's own plugin skill is untouched
    const own = parseToolboxFrontmatter(readFileSync(join(home, "plugins", "cache", "claude-plugins-official", "corpocode", "skills", "corpocode-router", "SKILL.md"), "utf8"));
    expect(own.gated).toBe(false);
    expect(own.description).toBe("Re-run the categorizer.");

    // catalog holds the ORIGINAL descriptions
    const cat = loadCatalog(catalog);
    const fooEntry = cat.entries.find((e) => e.name === "foo")!;
    expect(fooEntry.description).toBe("Use foo when doing X.");
    expect(fooEntry.scope).toBe("user");
    expect(cat.entries.find((e) => e.name === "baz")!.scope).toBe("plugin");
  });

  it("is idempotent: a second run gates nothing", () => {
    const home = setupClaudeHome();
    const restore = tmp("cc-restore-");
    const catalog = join(tmp("cc-cat-"), "catalog.json");
    gate(home, restore, catalog);
    expect(gate(home, restore, catalog).gated).toBe(0);
  });

  it("self-heals: a plugin file overwritten un-gated is re-gated on the next run", () => {
    const home = setupClaudeHome();
    const restore = tmp("cc-restore-");
    const catalog = join(tmp("cc-cat-"), "catalog.json");
    gate(home, restore, catalog);
    // simulate `/plugin update` restoring the un-gated original
    const baz = join(home, "plugins", "cache", "mkt", "someplugin", "skills", "baz", "SKILL.md");
    writeFileSync(baz, "---\nname: baz\ndescription: Baz does Z.\n---\nbody\n");
    expect(gate(home, restore, catalog).gated).toBe(1); // baz re-gated
    expect(parseToolboxFrontmatter(readFileSync(baz, "utf8")).gated).toBe(true);
  });

  it("restores every original byte-for-byte", () => {
    const home = setupClaudeHome();
    const restore = tmp("cc-restore-");
    const catalog = join(tmp("cc-cat-"), "catalog.json");
    const fooBefore = readFileSync(join(home, "agents", "foo.md"), "utf8");

    gate(home, restore, catalog);
    expect(readFileSync(join(home, "agents", "foo.md"), "utf8")).not.toBe(fooBefore); // gated

    const { restored } = restoreToolbox({ restoreDir: restore, catalogPath: catalog });
    expect(restored).toBe(3);
    expect(readFileSync(join(home, "agents", "foo.md"), "utf8")).toBe(fooBefore); // original back, marker gone
  });
});
