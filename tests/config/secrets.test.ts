import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, saveSecrets, resolveApiKey } from "../../src/config/secrets";
import { secretsFile } from "../../src/config/paths";

describe("secrets", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-sec-"));
    env = { CORPOCODE_HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("returns an empty map for a missing store", () => {
    expect(loadSecrets(env)).toEqual({});
  });

  it("round-trips secrets", () => {
    saveSecrets({ ANTHROPIC_API_KEY: "sk-abc", FOO: "bar" }, env);
    expect(loadSecrets(env)).toEqual({ ANTHROPIC_API_KEY: "sk-abc", FOO: "bar" });
  });

  it("writes owner-only permissions on POSIX", () => {
    saveSecrets({ K: "v" }, env);
    const mode = statSync(secretsFile(env)).mode & 0o777;
    // POSIX-only assertion: Windows governs access via ACLs, not mode bits.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("resolves apiKeyRef from the secrets file first", () => {
    expect(resolveApiKey({ kind: "anthropic", apiKeyRef: "MY_KEY" }, { MY_KEY: "sk-1" }, {})).toBe("sk-1");
  });

  it("falls back to the conventional env var when no ref is set", () => {
    expect(resolveApiKey({ kind: "openai" }, {}, { OPENAI_API_KEY: "sk-2" })).toBe("sk-2");
  });

  it("returns undefined for keyless providers", () => {
    expect(resolveApiKey({ kind: "ollama" }, {}, {})).toBeUndefined();
    expect(resolveApiKey({ kind: "anthropic-cli" }, {}, {})).toBeUndefined();
  });
});
