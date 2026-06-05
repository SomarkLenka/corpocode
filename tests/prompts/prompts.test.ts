import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate, templateVars } from "../../src/prompts/render";
import { resolveTemplate, resolvePrompt } from "../../src/prompts/resolve";
import { BUILTIN_PROMPTS } from "../../src/prompts/registry";
import { scaffoldPrompts } from "../../src/prompts/scaffold";
import { promptsDir, globalPromptsDir } from "../../src/config/paths";

describe("renderTemplate", () => {
  it("fills known placeholders and leaves unknown ones intact", () => {
    expect(renderTemplate("a {{x}} b {{ y }} c", { x: "1", y: "2" })).toBe("a 1 b 2 c");
    expect(renderTemplate("keep {{missing}}", {})).toBe("keep {{missing}}"); // signals a removed var
  });
  it("lists referenced variables", () => {
    expect(templateVars("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("resolveTemplate precedence (local → global → built-in)", () => {
  const env = {};
  const cwd = "/proj";
  const local = join(promptsDir(cwd, env), "router.md");
  const global = join(globalPromptsDir(env), "router.md");
  const seam = (files: Record<string, string>) => (p: string) => files[p] ?? null;

  it("prefers the project-local file", () => {
    const r = resolveTemplate("router", { cwd, env, readFile: seam({ [local]: "LOCAL", [global]: "GLOBAL" }) });
    expect(r).toBe("LOCAL");
  });
  it("falls back to the global file when no local file", () => {
    expect(resolveTemplate("router", { cwd, env, readFile: seam({ [global]: "GLOBAL" }) })).toBe("GLOBAL");
  });
  it("falls back to the built-in default when neither file exists", () => {
    expect(resolveTemplate("router", { cwd, env, readFile: () => null })).toBe(BUILTIN_PROMPTS.router);
  });
  it("treats a present-but-empty override as not set", () => {
    expect(resolveTemplate("router", { cwd, env, readFile: seam({ [local]: "   \n" }) })).toBe(BUILTIN_PROMPTS.router);
  });
  it("strips a leading <!-- --> guidance header so it never reaches the model", () => {
    const file = "<!-- editing guidance: keep {{candidates}} -->\n\nACTUAL PROMPT {{candidates}}";
    expect(resolveTemplate("router", { cwd, env, readFile: seam({ [local]: file }) })).toBe("ACTUAL PROMPT {{candidates}}");
  });
});

describe("resolvePrompt", () => {
  it("resolves the template and fills its variables", () => {
    const out = resolvePrompt("router", { lineOfThought: "  intent: x", candidates: "  - a.ts" }, { readFile: () => null });
    expect(out).toContain("  intent: x");
    expect(out).toContain("  - a.ts");
    expect(out).not.toContain("{{"); // every placeholder filled
  });
  it("static prompts come through verbatim from the built-in default", () => {
    expect(resolvePrompt("filter-classify", {}, { readFile: () => null })).toBe(BUILTIN_PROMPTS["filter-classify"]);
  });
});

describe("scaffoldPrompts", () => {
  it("writes editable files with a stripped-on-read header, skips existing, and --force overwrites", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-prompts-"));
    const env = { CORPOCODE_HOME: home } as NodeJS.ProcessEnv;

    const first = scaffoldPrompts({ env });
    expect(first.wrote).toContain("router");
    const file = readFileSync(join(home, "prompts", "router.md"), "utf8");
    expect(file).toContain("<!-- CorpoCode prompt"); // guidance header present on disk
    expect(file).toContain("{{candidates}}"); // placeholders documented in the body

    // resolved form (real fs) drops the header but keeps the body
    const resolved = resolveTemplate("router", { env });
    expect(resolved).not.toContain("<!--");
    expect(resolved).toContain("{{candidates}}");

    // re-running keeps the (possibly-edited) file
    expect(scaffoldPrompts({ env }).skipped).toContain("router");
    // --force rewrites it
    expect(scaffoldPrompts({ env, force: true }).wrote).toContain("router");
    expect(existsSync(join(home, "prompts", "filter-classify.md"))).toBe(true);
  });
});
