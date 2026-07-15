import { describe, expect, it } from "vitest";
import { compileTasks } from "../../src/orchestrator/decompose";
import type { Spec } from "../../src/um/spec-schema";
import { emitTasksFile } from "../../src/um/harvest/tasks-schema";

function spec(): Spec {
  return {
    version: 1,
    runId: "run-x",
    task: "add dark mode",
    entities: [{ name: "ThemeState", description: "persisted theme choice", fields: ["mode"] }],
    contracts: [
      {
        name: "ThemeProvider",
        kind: "api",
        signature: "interface ThemeProvider { theme: 'light'|'dark'; setTheme(t): void }",
        description: "theme context",
      },
      { name: "UnrelatedThing", kind: "api", signature: "x", description: "not referenced anywhere" },
    ],
    constraints: ["no new runtime dependencies"],
    futureSeams: [],
    compartments: [],
    scalePath: [],
    reusableSystems: [],
    acceptance: [
      {
        id: "ac1",
        criterion: "WHEN the toggle is clicked THE SYSTEM SHALL persist the theme",
        verify: { method: "command", command: "npx vitest run tests/theme" },
      },
    ],
    taskSeeds: [
      {
        id: "t1",
        title: "ThemeProvider wiring",
        description: "wire the ThemeProvider contract into the app shell",
        files: ["src/ui/"],
        dependsOn: [],
        verifyCommand: "npx vitest run tests/theme",
        acceptanceRefs: ["ac1"],
      },
    ],
    decisions: [
      {
        pollId: "fork-1",
        section: "api-spec",
        concept: "persistence",
        question: "Where should the theme persist?",
        options: [{ id: "ls", label: "localStorage", findings: [] }],
        answer: { pollId: "fork-1", optionId: "ls", source: "pilot" },
        at: 1,
      },
    ],
    sections: {
      "api-spec": "complete",
      "capability-expansion": "complete",
      "future-plans": "complete",
      parallelization: "complete",
      compartmentalization: "complete",
      "scale-path": "complete",
      "reusable-systems": "complete",
    },
  } as Spec;
}

describe("compileTasks", () => {
  it("compiles a four-field brief and inlines traceable context", () => {
    const s = spec();
    const emitted = emitTasksFile(s);
    if (!emitted.ok) throw new Error(emitted.error);
    const [task] = compileTasks(s, emitted.file);
    expect(task!.brief!.objective).toContain("ThemeProvider wiring");
    expect(task!.brief!.toolGuidance).toContain("npx vitest run tests/theme");
    expect(task!.brief!.boundaries).toContain("src/ui/");
    expect(task!.compiledContext).toContain("[ac1] WHEN the toggle is clicked"); // criterion with stable id
    expect(task!.compiledContext).toContain("ThemeProvider"); // name-matched contract inlined
    expect(task!.compiledContext).not.toContain("UnrelatedThing"); // unmatched contract omitted
    expect(task!.compiledContext).toContain("no new runtime dependencies"); // constraints always inlined
    expect(task!.compiledContext).toContain("persistence: localStorage"); // decisions ledger digest
  });

  it("routes all inlined context through the injected sanitizer", () => {
    const s = spec();
    s.constraints = ["never log sk-ant-abc123def456ghi789jkl0"];
    const emitted = emitTasksFile(s);
    if (!emitted.ok) throw new Error(emitted.error);
    const [task] = compileTasks(s, emitted.file, { sanitize: (text) => text.replace(/sk-ant-\S+/g, "[GONE]") });
    expect(task!.compiledContext).toContain("[GONE]");
    expect(task!.compiledContext).not.toContain("sk-ant-");
  });
});
