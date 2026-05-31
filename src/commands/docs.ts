// `corpocode docs [--out <dir>]` — emit the source-derived reference material. With --out it writes the
// config and command reference markdown files (the references the docs site embeds); without it, it
// prints them to stdout. The point is that these two references are generated, never hand-maintained,
// so they cannot fall out of date with the schema and the CLI (Phase 4 §5).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../config/paths";
import { generateConfigReference } from "../docs-site/config-reference";
import { generateCommandReference } from "../docs-site/command-reference";

export function runDocsCommand(argv: string[]): void {
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const config = generateConfigReference();
  const commands = generateCommandReference();

  if (out) {
    ensureDir(out);
    writeFileSync(join(out, "config-reference.md"), config);
    writeFileSync(join(out, "command-reference.md"), commands);
    process.stdout.write(`Wrote config-reference.md and command-reference.md to ${out}\n`);
    return;
  }

  process.stdout.write(`${config}\n${commands}\n`);
}
