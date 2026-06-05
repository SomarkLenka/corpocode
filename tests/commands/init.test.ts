// `corpocode init` — scaffolds config + a placeholder secrets file so a plugin-only user can
// self-provision without npm. The load-bearing guarantee is that it NEVER overwrites a real key.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand, renderSecretsTemplate, defaultKeyNames } from "../../src/commands/init";
import { configFile, secretsFile } from "../../src/config/paths";
import { configSchema } from "../../src/config/schema";
import { parseToolboxFrontmatter } from "../../src/toolbox/frontmatter";

const dirs: string[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true); // quiet the command's output in test logs
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "cc-init-"));
  // Redirect CLAUDE_CONFIG_DIR to a temp dir too, so init's gate scan NEVER touches the real ~/.claude.
  const claude = mkdtempSync(join(tmpdir(), "cc-init-claude-"));
  dirs.push(d, claude);
  return { CORPOCODE_HOME: d, CLAUDE_CONFIG_DIR: claude } as NodeJS.ProcessEnv;
}

describe("corpocode init", () => {
  it("writes a valid default config and a keyless secrets template (anthropic-cli needs no key)", () => {
    const env = home();
    runInitCommand([], env);
    const cfg = configSchema.parse(JSON.parse(readFileSync(configFile(env), "utf8")));
    expect(cfg.version).toBe(1);
    expect(cfg.providers.default.kind).toBe("anthropic-cli");
    const secrets = readFileSync(secretsFile(env), "utf8");
    expect(secrets).toContain("anthropic-cli"); // explains no key is needed
    expect(secrets).not.toContain("REPLACE_WITH_YOUR_"); // no placeholder to fill
  });

  it("never overwrites an existing secrets file without --force (a real key is safe)", () => {
    const env = home();
    runInitCommand([], env); // create the dir + keyless template
    writeFileSync(secretsFile(env), "ANTHROPIC_API_KEY=sk-real-key\n", { mode: 0o600 });

    runInitCommand([], env); // again, no --force
    expect(readFileSync(secretsFile(env), "utf8")).toContain("sk-real-key"); // preserved

    runInitCommand(["--force"], env); // --force resets to the keyless template
    const reset = readFileSync(secretsFile(env), "utf8");
    expect(reset).not.toContain("sk-real-key");
    expect(reset).toContain("anthropic-cli");
  });

  it("derives no key names from the keyless default, but still renders placeholders for keyed providers", () => {
    expect(defaultKeyNames()).toEqual([]); // anthropic-cli + ollama are both keyless
    expect(renderSecretsTemplate([])).toContain("anthropic-cli"); // keyless guidance
    expect(renderSecretsTemplate(["ANTHROPIC_API_KEY"])).toContain("ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_ANTHROPIC_API_KEY");
  });

  it("gates skills found under CLAUDE_CONFIG_DIR; --no-gate skips", () => {
    const env = home();
    const claude = env.CLAUDE_CONFIG_DIR!;
    const skill = join(claude, "skills", "demo", "SKILL.md");
    mkdirSync(join(claude, "skills", "demo"), { recursive: true });
    writeFileSync(skill, "---\nname: demo\ndescription: Use demo for X.\n---\nbody\n");

    runInitCommand([], env);
    expect(parseToolboxFrontmatter(readFileSync(skill, "utf8")).gated).toBe(true);

    // --no-gate on a fresh fixture leaves it alone
    const env2 = home();
    const skill2 = join(env2.CLAUDE_CONFIG_DIR!, "skills", "demo", "SKILL.md");
    mkdirSync(join(env2.CLAUDE_CONFIG_DIR!, "skills", "demo"), { recursive: true });
    writeFileSync(skill2, "---\nname: demo\ndescription: Use demo for X.\n---\nbody\n");
    runInitCommand(["--no-gate"], env2);
    expect(parseToolboxFrontmatter(readFileSync(skill2, "utf8")).gated).toBe(false);
  });
});
