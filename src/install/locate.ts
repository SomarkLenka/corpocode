// Resolve the installed package root at runtime so the install command can find the agent/skill
// assets to copy into Claude Code's directories. Uses argv[1] (the bin path) rather than
// __dirname so it works identically in the bundled CJS binary and under the typechecker.
import { dirname, join } from "node:path";

export function packageRoot(argv: string[] = process.argv): string {
  const script = argv[1];
  // The bundled bin lives at <packageRoot>/bin/corpocode.js.
  if (script) return join(dirname(script), "..");
  return process.cwd();
}
