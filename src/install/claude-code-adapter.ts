// Claude Code as a PlatformAdapter (for the multi-platform registry and runtime output shaping).
// The npm-channel installer `installClaudeCode` remains the canonical Claude install path; this
// adapter exposes the same registration shape behind the common interface so `--all` can treat
// every platform uniformly.
import { makeAdapter } from "./platform";

export const claudeCodeAdapter = makeAdapter({
  id: "claude-code",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  homeSubdir: ".claude",
  settingsRel: "settings.json",
  shimSubdir: "hooks",
  specs: [
    { event: "UserPromptSubmit" },
    { event: "PreToolUse", matcher: "*" },
    { event: "PostToolUse", matcher: "Write|Edit" },
    { event: "Stop" },
  ],
  agents: ["haiku-helper"],
  skills: ["corpocode-router", "corpocode-setup"],
});
