// `corpocode prompts` — write the built-in default system prompts to ~/.corpocode/prompts/ as editable
// .md files so a user can tune any component's prompt. A project-local ./.corpocode/prompts/<id>.md
// overrides the global copy; both override the built-in default. Never clobbers an edited file unless
// --force is passed.
import { scaffoldPrompts } from "../prompts/scaffold";

export function runPromptsCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const force = argv.includes("--force");
  const { dir, wrote, skipped } = scaffoldPrompts({ env, force });
  process.stdout.write(`Prompts dir: ${dir}\n`);
  if (wrote.length) process.stdout.write(`wrote ${wrote.length} prompt file(s): ${wrote.join(", ")}\n`);
  if (skipped.length) {
    process.stdout.write(`· kept ${skipped.length} existing file(s) (use --force to overwrite): ${skipped.join(", ")}\n`);
  }
  process.stdout.write(
    "\nEdit any file to customize that component's system prompt. A project-local " +
      "./.corpocode/prompts/<id>.md overrides the global copy; delete a file to revert to the built-in default.\n",
  );
}
