// Docs generation from source (Phase 4 §5). The config reference is derived from the Zod schema and the
// command reference from the command registry, so neither can drift from the code. These tests assert
// that source-derived fields/commands actually appear — add a field or command and it shows up here.
import { describe, it, expect } from "vitest";
import { generateConfigReference } from "../../src/docs-site/config-reference";
import { generateCommandReference } from "../../src/docs-site/command-reference";
import { COMMANDS } from "../../src/cli-commands";

describe("config reference (generated from the schema)", () => {
  it("includes source-derived fields with their defaults", () => {
    const md = generateConfigReference();
    expect(md).toContain("`telemetry.enabled`");
    expect(md).toContain("`git.trace_branch`");
    expect(md).toContain("corpocode/trace"); // the actual default value, pulled from the schema
    expect(md).toContain("`delegation.mode`");
    expect(md).toContain("`version`");
    expect(md).toContain("do not edit by hand");
  });
});

describe("command reference (generated from the registry)", () => {
  it("lists every command the CLI registry defines", () => {
    const md = generateCommandReference();
    for (const c of COMMANDS) {
      expect(md).toContain(`corpocode ${c.usage}`);
      expect(md).toContain(c.summary);
    }
  });

  it("covers the commands the CLI actually dispatches", () => {
    // A drift guard: the registry the help and docs render from must include the real commands.
    const names = COMMANDS.map((c) => c.name);
    for (const expected of ["install", "doctor", "stats", "telemetry", "skillify", "review", "docs"]) {
      expect(names).toContain(expected);
    }
  });
});
