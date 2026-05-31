// Codex CLI adapter. Codex exposes a full set of lifecycle hooks comparable to Claude Code's.
// CONFIRM AT INTEGRATION: the home dir (`~/.codex`, overridable by CODEX_HOME), the settings file
// name, and the response envelope field — see hooks/platform-output.ts. The adapter is the seam
// where those specifics live; nothing central changes when they are confirmed.
import { makeAdapter } from "./platform";

export const codexAdapter = makeAdapter({
  id: "codex",
  homeEnvVar: "CODEX_HOME",
  homeSubdir: ".codex",
  settingsRel: "hooks.json",
  shimSubdir: "hooks",
  specs: [
    { event: "UserPromptSubmit" },
    { event: "PreToolUse", matcher: "*" },
    { event: "PostToolUse", matcher: "Write|Edit" },
    { event: "Stop" },
  ],
  agents: [],
  skills: [],
});
