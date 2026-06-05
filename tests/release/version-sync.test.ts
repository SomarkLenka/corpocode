import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const readJson = (...p: string[]): { version?: string } => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));

describe("plugin version sync", () => {
  it("plugin.json version matches package.json (run `npm run sync-version` if this fails)", () => {
    // /plugin update reads .claude-plugin/plugin.json's version; if it drifts from package.json the
    // released bundle and the version users see disagree. sync-plugin-version.mjs keeps them equal.
    const pkg = readJson("package.json");
    const plugin = readJson(".claude-plugin", "plugin.json");
    expect(plugin.version).toBe(pkg.version);
  });
});
