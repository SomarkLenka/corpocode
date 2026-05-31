// Register/unregister CorpoCode's hooks inside Claude Code's settings.json by manipulating the
// parsed object — never editing text — so unrelated settings can't be corrupted. Idempotent:
// our entries are identified by the "corpocode" marker in their command, so re-running replaces
// rather than duplicates them.
export interface HookSpec {
  name: string;
  matcher?: string;
}

export const HOOK_SPECS: HookSpec[] = [
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: "*" },
  { name: "PostToolUse", matcher: "Write|Edit" },
  { name: "Stop" },
  { name: "SessionStart" },
];

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** A hook group is ours if any of its commands references the corpocode binary/shim. */
export function isCorpocodeGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => typeof h?.command === "string" && h.command.includes("corpocode"))
  );
}

export function registerHooks(settings: Settings, commandFor: (name: string) => string): Settings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  for (const spec of HOOK_SPECS) {
    const preserved = (hooks[spec.name] ?? []).filter((g) => !isCorpocodeGroup(g));
    const group: HookGroup = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: commandFor(spec.name) }],
    };
    hooks[spec.name] = [...preserved, group];
  }
  return { ...settings, hooks };
}

export function unregisterHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const preserved = groups.filter((g) => !isCorpocodeGroup(g));
    if (preserved.length) hooks[event] = preserved;
  }
  return { ...settings, hooks };
}

export function hasCorpocodeHooks(settings: Settings): boolean {
  return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isCorpocodeGroup));
}
