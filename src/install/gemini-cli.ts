// Gemini CLI adapter. Its hook model centers on prompt submission and session end, so this adapter
// declares only UserPromptSubmit and Stop — CorpoCode runs the categorizer and the compactor there,
// and degrades away the tool-level components cleanly. CONFIRM AT INTEGRATION: home (`~/.gemini`),
// settings format, and envelope field (hooks/platform-output.ts).
import { makeAdapter } from "./platform";

export const geminiCliAdapter = makeAdapter({
  id: "gemini-cli",
  homeEnvVar: "GEMINI_CONFIG_DIR",
  homeSubdir: ".gemini",
  settingsRel: "hooks.json",
  shimSubdir: "hooks",
  specs: [{ event: "UserPromptSubmit" }, { event: "Stop" }],
  agents: [],
  skills: [],
});
