// The registry of platform adapters. `--all` iterates the ones `detect()` finds; `--platform <id>`
// resolves one by name. Adding a platform is adding one adapter file and one entry here — no central
// code changes, which is the whole point of the seam.
import type { PlatformAdapter, PlatformId } from "./platform";
import { claudeCodeAdapter } from "./claude-code-adapter";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";
import { cursorAdapter } from "./cursor";
import { geminiCliAdapter } from "./gemini-cli";

export const PLATFORM_ADAPTERS: Record<PlatformId, PlatformAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  "gemini-cli": geminiCliAdapter,
};

export function getPlatformAdapter(id: string): PlatformAdapter | null {
  return (PLATFORM_ADAPTERS as Record<string, PlatformAdapter>)[id] ?? null;
}

/** Adapters whose platform is actually installed on this machine. */
export function detectPlatforms(env: NodeJS.ProcessEnv = process.env): PlatformAdapter[] {
  return Object.values(PLATFORM_ADAPTERS).filter((a) => a.detect(env));
}
