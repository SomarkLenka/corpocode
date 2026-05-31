// Process entry point. Deliberately trivial: hand straight off to the CLI router so all
// real logic lives in command/hook handlers (A — atomicity).
import { runCli } from "./cli";

void runCli(process.argv.slice(2));
