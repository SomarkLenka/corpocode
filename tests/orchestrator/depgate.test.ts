import { describe, expect, it } from "vitest";
import { extractNewDeps, checkDeps } from "../../src/orchestrator/depgate";

const DIFF = [
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -10,6 +10,8 @@",
  '   "dependencies": {',
  '     "zod": "^3.23.0",',
  '+    "left-pad": "^1.3.0",',
  '+    "totally-hallucinated-pkg": "2.0.0",',
  "   },",
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1 +1,2 @@",
  '+import { pad } from "left-pad";',
].join("\n");

describe("extractNewDeps", () => {
  it("finds added manifest entries, ignoring source-file lines", () => {
    const deps = extractNewDeps(DIFF);
    expect(deps).toEqual([
      { file: "package.json", name: "left-pad", version: "^1.3.0" },
      { file: "package.json", name: "totally-hallucinated-pkg", version: "2.0.0" },
    ]);
  });

  it("returns empty for a diff with no manifest changes", () => {
    expect(extractNewDeps('+++ b/src/y.ts\n+const x = { "a": "1.0.0" };')).toEqual([]);
  });
});

describe("checkDeps", () => {
  const deps = [
    { file: "package.json", name: "zod", version: "^3.23.0" },
    { file: "package.json", name: "totally-hallucinated-pkg", version: "2.0.0" },
  ];

  it("passes allowlisted deps, flags new ones — no network by default", async () => {
    const findings = await checkDeps(deps, { allowlist: new Set(["zod"]) });
    expect(findings[0]!.verdict).toBe("allowlisted");
    expect(findings[1]!.verdict).toBe("not-allowlisted");
  });

  it("with registry_check, a 404 upgrades the verdict to not-in-registry", async () => {
    const fetchFn = (async (url: string | URL) => ({
      ok: false,
      status: String(url).includes("totally-hallucinated-pkg") ? 404 : 200,
    })) as unknown as typeof fetch;
    const findings = await checkDeps(deps.slice(1), { allowlist: new Set(), registryCheck: true, fetchFn });
    expect(findings[0]!.verdict).toBe("not-in-registry");
  });

  it("a registry error degrades to not-allowlisted (never crashes, never approves)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const findings = await checkDeps(deps.slice(1), { allowlist: new Set(), registryCheck: true, fetchFn });
    expect(findings[0]!.verdict).toBe("not-allowlisted");
  });
});
