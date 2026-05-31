// Generate the command reference FROM the command registry (Phase 4 §5). It renders the same COMMANDS
// array the CLI's --help renders, so the reference, the help text, and the dispatched commands are one
// source of truth and cannot drift apart.
import { COMMANDS } from "../cli-commands";

export function generateCommandReference(): string {
  const rows = COMMANDS.map((c) => `| \`corpocode ${c.usage}\` | ${c.summary} |`).join("\n");
  return (
    "# Command reference\n\n" +
    "_Generated from `src/cli-commands.ts` — do not edit by hand._\n\n" +
    "| Command | Description |\n| --- | --- |\n" +
    `${rows}\n`
  );
}
