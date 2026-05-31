---
name: corpocode-router
description: Manually re-run the CorpoCode moment categorizer using the current conversation state. Use when context has shifted significantly (a long exploration revealed new structure) and the original routing recommendation is stale.
---

# CorpoCode Router

CorpoCode normally classifies each turn automatically on `UserPromptSubmit`. Invoke this skill to
re-run that classification on demand when the situation has moved on from the opening prompt.

What it does:
1. Reads the current line of thought from the session transcript.
2. Scores the codebase for the files now most relevant (graph-backed, with a string-overlap
   fallback before the graph is built).
3. Recalls any prior decisions and approaches from memory.
4. Emits a fresh `<middle-management recommendation>` block — classification, candidate files,
   and recalled context — for the main model to steer with.

It is advisory only: it injects context, it does not change what you do.

To trigger a re-classification, run:

```
corpocode hook UserPromptSubmit
```

with the current session payload, or simply continue — the next turn re-classifies automatically.
