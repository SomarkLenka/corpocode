// `corpocode skillify` — the user-facing entry to the skill loop. Two explicit steps, never fused:
//   default     → mine memories into candidate memos for review (writes to the candidates dir only)
//   --promote   → install already-reviewed candidates as real skills
// The split keeps the durable, consequential step (installing into the skill library) behind an
// explicit user action, with a review checkpoint in between.
import { cwd } from "node:process";
import { loadConfig } from "../config/load";
import { projectKey } from "../config/paths";
import { buildRegistry } from "../providers/registry";
import { buildMemoryStore } from "../backends/memory/registry";
import { generateSkillCandidates, candidatesDir } from "../loops/skillgen";
import { promoteCandidates } from "../loops/skillify";

export async function runSkillifyCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv.includes("--promote")) {
    const result = promoteCandidates({ env });
    if (result.promoted.length === 0 && result.skipped.length === 0) {
      process.stdout.write(`No candidates to promote in ${candidatesDir(env)}.\n`);
      return;
    }
    process.stdout.write(`Promoted ${result.promoted.length} skill(s): ${result.promoted.join(", ") || "(none)"}\n`);
    if (result.skipped.length > 0) {
      process.stdout.write(`Skipped ${result.skipped.length} invalid memo(s): ${result.skipped.join(", ")}\n`);
    }
    return;
  }

  const config = loadConfig({ env });
  const project = projectKey(cwd());
  const registry = buildRegistry(config, { env });
  const memory = buildMemoryStore(config, { project, env });

  const result = await generateSkillCandidates({
    memory,
    provider: registry.forComponent("retrieval"),
    scope: { project, workspaceCascade: false },
    env,
  });

  if (result.written === 0) {
    process.stdout.write(
      result.mined === 0
        ? "No mistake/approach memories yet — nothing to distill into skills.\n"
        : `Mined ${result.mined} memories but distilled no candidates.\n`,
    );
    return;
  }
  process.stdout.write(`Wrote ${result.written} candidate skill(s) to ${candidatesDir(env)}:\n`);
  for (const name of result.names) process.stdout.write(`  - ${name}\n`);
  process.stdout.write("Review them, then run `corpocode skillify --promote` to install.\n");
}
