// Keeps .claude-plugin/plugin.json's version in lockstep with package.json — the one number that
// `/plugin update` reads to decide whether a new build is available. Run with no argument it syncs
// from package.json; run with an explicit version (semantic-release passes nextRelease.version) it
// pins that. Idempotent and quiet when already in sync, so it's safe in build/release hot paths.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const version = process.argv[2] ?? pkg.version;

const pluginUrl = new URL(".claude-plugin/plugin.json", root);
const plugin = JSON.parse(readFileSync(pluginUrl, "utf8"));

if (plugin.version === version) {
  console.log(`plugin.json already at ${version}`);
} else {
  plugin.version = version;
  writeFileSync(pluginUrl, `${JSON.stringify(plugin, null, 2)}\n`);
  console.log(`synced plugin.json version → ${version}`);
}
