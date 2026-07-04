# Writing a CorpoCode plugin

CorpoCode is extended at exactly two seams: the **retrieval templates** that tell the retrieval team
what to gather for a kind of task, and the **MOLAR-EDIT tenet checks** that tell the verifier and the
design-review team what to check. A plugin contributes *definitions* at these seams — never imperative
behavior — so installing one extends the data CorpoCode reasons over without handing it free rein.

## Discovery

Discovery is by package name, the same convention ESLint and Babel use. Install a package whose name
matches one of these and it auto-registers at startup — nothing to wire up:

- `corpocode-template-*` — contributes retrieval templates
- `corpocode-tenet-*` — contributes tenet checks

Every discovered plugin appears in `corpocode doctor`, so you can always see what is extending your
install. A plugin that throws while loading is **skipped, not fatal** (the same fail-open rule as the
rest of the system), and a plugin that targets a different `apiVersion` is declined cleanly.

## The contract

```typescript
export interface CorpoPlugin {
  readonly apiVersion: 1;            // the API generation this plugin targets
  readonly name: string;
  templates?: RetrievalTemplate[];  // for corpocode-template-* packages
  tenets?: TenetCheck[];            // for corpocode-tenet-* packages
}
```

Your package's default export must be a `CorpoPlugin`.

### A retrieval template

```typescript
export default {
  apiVersion: 1,
  name: "corpocode-template-graphql",
  templates: [
    {
      type: "graphql-resolver",                 // a new moment type the planner can select
      build: (cues, prompt) => [
        { kind: "query_graph", label: "schema", priority: 0.9, query: `${cues.query} schema`, budget: 800 },
        { kind: "mem_recall", label: "lessons", priority: 0.7, query: prompt, kinds: ["mistake", "rule"], limit: 5 },
      ],
    },
  ],
};
```

Built-in moment types always win, so a plugin can **add** a type but never silently override a core one.

### A tenet check

```typescript
export default {
  apiVersion: 1,
  name: "corpocode-tenet-sql-safety",
  tenets: [
    {
      tenet: "I",                                 // runs only when the I tenet is active
      name: "sql:parameterized-queries",
      appliesTo: (file) => /\.(ts|js|py)$/.test(file.path),
      prompt: "Flag any SQL built by string concatenation; require parameterized queries.",
    },
  ],
};
```

A contributed check runs in the verifier fan-out exactly like a built-in, and a runtime failure in it
degrades the same way — the check is dropped and the turn proceeds.

## Rules of the road

- Keep `apiVersion` accurate; it is how an incompatible plugin is declined rather than mis-loaded.
- Contribute definitions only — no side effects at import time.
- Expect to be skipped on error: never assume your plugin is the only one, or that it must load.
