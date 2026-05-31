// `corpocode init` — scaffolds config + a placeholder secrets file so a plugin-only user can
// self-provision without npm. The load-bearing guarantee is that it NEVER overwrites a real key.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand, renderSecretsTemplate, defaultKeyNames } from "../../src/commands/init";
import { configFile, secretsFile } from "../../src/config/paths";
import { configSchema } from "../../src/config/schema";

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
  dirs.push(d);
  return { CORPOCODE_HOME: d } as NodeJS.ProcessEnv;
}

describe("corpocode init", () => {
  it("writes a valid default config and a secrets file with a key placeholder", () => {
    const env = home();
    runInitCommand([], env);
    const cfg = configSchema.parse(JSON.parse(readFileSync(configFile(env), "utf8")));
    expect(cfg.version).toBe(1);
    expect(readFileSync(secretsFile(env), "utf8")).toContain("ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_ANTHROPIC_API_KEY");
  });

  it("never overwrites an existing secrets file without --force (a real key is safe)", () => {
    const env = home();
    runInitCommand([], env); // create the dir + placeholder secrets
    writeFileSync(secretsFile(env), "ANTHROPIC_API_KEY=sk-real-key\n", { mode: 0o600 });

    runInitCommand([], env); // again, no --force
    expect(readFileSync(secretsFile(env), "utf8")).toContain("sk-real-key"); // preserved

    runInitCommand(["--force"], env); // --force resets to the placeholder
    expect(readFileSync(secretsFile(env), "utf8")).toContain("REPLACE_WITH_YOUR_ANTHROPIC_API_KEY");
  });

  it("derives the key names from the default config's keyed providers", () => {
    expect(defaultKeyNames()).toContain("ANTHROPIC_API_KEY"); // anthropic default
    expect(renderSecretsTemplate(["ANTHROPIC_API_KEY"])).toContain("ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_ANTHROPIC_API_KEY");
  });
});
