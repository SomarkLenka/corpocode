// opencode adapter. CONFIRM AT INTEGRATION: opencode's config lives under `~/.config/opencode`
// (overridable by OPENCODE_CONFIG); the hook registration format and envelope field are documented
// best-effort in hooks/platform-output.ts.
import { makeAdapter } from "./platform";

export const opencodeAdapter = makeAdapter({
  id: "opencode",
  homeEnvVar: "OPENCODE_CONFIG",
  homeSubdir: ".config/opencode",
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
