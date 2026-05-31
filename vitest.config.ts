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
  },
});
