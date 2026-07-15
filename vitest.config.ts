import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Mirror the build-time version define so code reading __CORPOCODE_VERSION__ behaves
  // identically under test and in the shipped bundle.
  define: { __CORPOCODE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    // A few suites shell out to real `git` subprocesses; on Windows under full-suite parallel
    // load an individual case can cross the 5s default (it passes in isolation in ~1s). Raise the
    // ceiling so the gate is deterministic — still low enough to catch a genuine hang.
    testTimeout: 20_000,
  },
});
