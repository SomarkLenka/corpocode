// Argument parsing → command handlers. Kept free of business logic: each command's
// behavior lives in its own module and is wired in here as milestones land.
import { runHook } from "./hooks/dispatch";
import { runInstallCommand, runProvisionCommand, runUninstallCommand } from "./commands/install";
import { runDoctorCommand } from "./commands/doctor";
import { runStatsCommand } from "./commands/stats";
import { runSkillifyCommand } from "./commands/skillify";
import { runReviewCommand } from "./commands/review";
import { runTelemetryCommand } from "./commands/telemetry";
import { runDocsCommand } from "./commands/docs";
import { COMMANDS } from "./cli-commands";

const VERSION = (typeof __CORPOCODE_VERSION__ === "string" && __CORPOCODE_VERSION__) || "0.0.0";

function renderHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  const lines = COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return (
    `corpocode ${VERSION} — cheap-model caretakers for coding agents\n\n` +
    "Usage: corpocode <command> [options]\n\nCommands:\n" +
    `${lines.join("\n")}\n` +
    `  ${"--version, -v".padEnd(width)}  Print the version\n` +
    `  ${"--help, -h".padEnd(width)}  Print this help\n\n` +
    "Run `corpocode <command> --help` for command-specific options."
  );
}

const HELP = renderHelp();

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "hook": {
      // Invoked by installed shims as `corpocode hook <name> [--platform <id>]`. Always exits clean.
      const pIdx = argv.indexOf("--platform");
      const platform = pIdx >= 0 ? argv[pIdx + 1] : undefined;
      await runHook(argv[1] ?? "", platform);
      return;
    }
    case "install":
      await runInstallCommand(rest);
      return;
    case "provision":
      await runProvisionCommand(rest);
      return;
    case "uninstall":
      await runUninstallCommand(rest);
      return;
    case "doctor":
      await runDoctorCommand(rest);
      return;
    case "stats":
      runStatsCommand(rest);
      return;
    case "skillify":
      await runSkillifyCommand(rest);
      return;
    case "review":
      runReviewCommand(rest);
      return;
    case "telemetry":
      runTelemetryCommand(rest);
      return;
    case "docs":
      runDocsCommand(rest);
      return;
    default:
      process.stderr.write(
        `corpocode: unknown command "${command}". Run \`corpocode --help\`.\n`,
      );
      process.exitCode = 1;
  }
}
