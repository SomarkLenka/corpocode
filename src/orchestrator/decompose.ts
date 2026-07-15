// Decompose-time compilation: each task becomes a self-contained brief + context bundle so a
// cold cheap worker needs no shared state and no retrieval. Deterministic — input tokens are
// cheap, so we inline generously; nothing here calls a model.
import type { Spec } from "../um/spec-schema";
import type { TasksFile, TaskBrief } from "../um/harvest/tasks-schema";

export type CompiledTask = TasksFile["tasks"][number] & { brief: TaskBrief; compiledContext: string };

export interface CompileOptions {
  /** Context-ingress sanitizer (Task 5); identity when omitted. */
  sanitize?: (text: string) => string;
}

const mentioned = (name: string, text: string) => text.toLowerCase().includes(name.toLowerCase());

export function compileTasks(spec: Spec, tasks: TasksFile, opts: CompileOptions = {}): CompiledTask[] {
  const sanitize = opts.sanitize ?? ((s: string) => s);

  return tasks.tasks.map((task): CompiledTask => {
    const seed = spec.taskSeeds.find((s) => s.id === task.id);
    const refs = new Set(seed?.acceptanceRefs ?? []);
    const criteria = spec.acceptance.filter((a) => refs.has(a.id));
    const surface = `${task.title} ${task.description}`;
    const contracts = spec.contracts.filter((c) => mentioned(c.name, surface));
    const entities = spec.entities.filter((e) => mentioned(e.name, surface));
    const decisions = spec.decisions.map((d) => {
      const label = d.answer.optionId
        ? (d.options.find((o) => o.id === d.answer.optionId)?.label ?? d.answer.optionId)
        : (d.answer.freeText ?? "unanswered");
      return `${d.concept}: ${label}`;
    });

    const context = [
      `# Task ${task.id}: ${task.title}`,
      `## Objective\n${task.description}`,
      `## Acceptance criteria (every one must pass)`,
      ...criteria.map((a) => `- [${a.id}] ${a.criterion}${a.verify.command ? ` — verify: \`${a.verify.command}\`` : ""}`),
      contracts.length ? `## Contracts\n${contracts.map((c) => `### ${c.name} (${c.kind})\n${c.signature}\n${c.description}`).join("\n")}` : "",
      entities.length ? `## Entities\n${entities.map((e) => `- ${e.name}: ${e.description} (fields: ${e.fields.join(", ")})`).join("\n")}` : "",
      `## Constraints\n${spec.constraints.map((c) => `- ${c}`).join("\n")}`,
      decisions.length ? `## Decisions already made (do not re-litigate)\n${decisions.map((d) => `- ${d}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const brief: TaskBrief = {
      objective: `${task.title} — ${task.description}`,
      outputFormat:
        "Author the change in this worktree and COMMIT it (conventional-commit messages). " +
        "Every acceptance criterion listed in the context must pass its verify command before you finish. " +
        "Your commits are the deliverable — do not print diffs or explanations as your final output.",
      toolGuidance:
        `Touch these paths: ${task.files.join(", ") || "(derive from the objective)"}. ` +
        (task.verifyCommand ? `Run \`${task.verifyCommand}\` before finishing; it must exit 0.` : "Run the repository's test command before finishing."),
      boundaries:
        `Modify ONLY within: ${task.files.join(", ") || "the paths implied by the objective"}. ` +
        "Do not add or upgrade dependencies. Do not touch .corpocode/, git config, or CI files. " +
        "Do not amend or rewrite existing commits.",
    };

    return { ...task, brief, compiledContext: sanitize(context) };
  });
}
