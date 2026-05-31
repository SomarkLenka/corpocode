// Build pipeline: bundle the whole CLI into a single self-contained file so that
// every hook invocation pays only Node startup, with no node_modules resolution.
// esbuild does the emit (fast, bundles); `tsc --noEmit` is the separate type gate.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "bin/corpocode.js",
  // The shebang makes the bundle directly executable as the `corpocode` binary.
  banner: { js: "#!/usr/bin/env node" },
  // Inline the version at build time so the runtime needs no package.json on disk.
  define: { __CORPOCODE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});
