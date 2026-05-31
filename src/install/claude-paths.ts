// Where Claude Code keeps its user-level config. Separate from CorpoCode's own ~/.corpocode state,
// which is what makes reinstalling the plugin never disturb a user's config, logs, or memory.
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export const claudeSettingsFile = (home: string): string => join(home, "settings.json");
export const claudeHooksDir = (home: string): string => join(home, "hooks");
export const claudeAgentsDir = (home: string): string => join(home, "agents");
export const claudeSkillsDir = (home: string): string => join(home, "skills");
export const claudePluginsDir = (home: string): string => join(home, "plugins");

// Project-scope agents/skills live under the repo's own .claude dir.
export const projectClaudeAgentsDir = (repoRoot: string): string => join(repoRoot, ".claude", "agents");
export const projectClaudeSkillsDir = (repoRoot: string): string => join(repoRoot, ".claude", "skills");
