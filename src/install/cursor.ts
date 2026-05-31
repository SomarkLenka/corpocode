// Cursor adapter. Cursor's hook surface is narrower than Claude Code's — it has no Stop or
// PreToolUse equivalent at the time of writing — so this adapter declares only the events it can
// fire. CorpoCode installs that subset cleanly: Cursor gets the categorizer and the post-write
// verifier, but not the context injector, the filter's teeth, or the compactor. CONFIRM AT
// INTEGRATION: exact home (`~/.cursor`), settings format, and envelope field.
import { makeAdapter } from "./platform";

export const cursorAdapter = makeAdapter({
  id: "cursor",
  homeEnvVar: "CURSOR_CONFIG_DIR",
  homeSubdir: ".cursor",
  settingsRel: "hooks.json",
  shimSubdir: "hooks",
  specs: [{ event: "UserPromptSubmit" }, { event: "PostToolUse", matcher: "Write|Edit" }],
  agents: [],
  skills: [],
});
