// The single source of truth for the command set. Both the CLI's --help and the generated command
// reference render from this array, so the help a user sees and the documentation a reader reads can
// never drift from each other or from the commands the CLI actually dispatches (Phase 4 §5).
export interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
}

export const COMMANDS: CommandDoc[] = [
  { name: "start", usage: 'start "<task>" [--answers <file>] [--yes] [--dev] [--resume <id>] [--list] [--status <id>]', summary: "Run the orchestrator: cockpit interrogation → spec + tasks artifacts" },
  { name: "build", usage: "build <runId> [--dry-run] [--allow-incomplete] [--dev]", summary: "Run the implementation swarm for an approved spec: decompose → waves → worktrees → verify → integrate" },
  { name: "install", usage: "install [--platform <name>] [--all] [--dry-run] [--skip-backends] [--repair]", summary: "Register hooks into a coding-agent platform" },
  { name: "provision", usage: "provision [--repair]", summary: "Install/start backends (graphify, OpenViking)" },
  { name: "uninstall", usage: "uninstall [--purge]", summary: "Remove shims and config (optionally Python tools)" },
  { name: "init", usage: "init [--force] [--no-orchestrator]", summary: "Scaffold config + secrets, then the orchestrator onboarding (unlocks `start`)" },
  { name: "prompts", usage: "prompts [--force]", summary: "Scaffold editable per-component system prompts into ~/.corpocode/prompts" },
  { name: "hook", usage: "hook <name> [--platform <id>]", summary: "Dispatch a hook (invoked by installed shims)" },
  { name: "doctor", usage: "doctor", summary: "Run health checks and print repair hints" },
  { name: "stats", usage: "stats [--json] [--days N]", summary: "Report cost, savings, latency, and error rates" },
  { name: "why", usage: "why [--session <id>] [--days N] [--json]", summary: "Explain the decisions CorpoCode made in a session" },
  { name: "monitor", usage: "monitor [--port N] [--no-open] [--lines N]", summary: "Open a live window onto corpocode's actions (flow + events)" },
  { name: "skillify", usage: "skillify [--promote]", summary: "Mine memories into skill candidates; --promote installs them" },
  { name: "review", usage: "review [--json] [--days N]", summary: "Audit the log; propose (never apply) config tweaks" },
  { name: "telemetry", usage: "telemetry <on|off|preview>", summary: "Opt-in aggregate telemetry; preview shows the exact payload" },
  { name: "docs", usage: "docs [--out <dir>]", summary: "Generate the config and command reference from source" },
];
