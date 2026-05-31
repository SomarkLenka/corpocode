// The GitManager: the trace recorder, the clean-branch curator, and the conflict surfacer. Trace
// commits are one-file-per-write and safe to do automatically (the trace branch never touches the
// user's working branch). Promotion groups a trace range into coherent commit sets — the same
// checklist-decomposition shape the retrieval team uses (one pass per file → a bucket → a
// deterministic aggregate) — and squashes them onto the clean branch. Destructive operations are
// absent by construction (see plumbing's `git()` guard).
import { isAbsolute, join } from "node:path";
import { spawnRunner, type CommandRunner } from "../install/run";
import { branchExists, commitFilesToBranch, git, relPath, revParse } from "./plumbing";
import type { BranchPair, CommitSet, GitManager, GitMode } from "./types";

export interface GitManagerOptions {
  repoRoot: string;
  traceBranch: string;
  cleanBranch: string;
  run?: CommandRunner;
  /** Sort a changed file into a logical concern bucket. Default: by directory. */
  groupBy?: (file: string) => string;
  /** Synthesize a commit message for a bucket. Default: a structured template. */
  messageFor?: (bucket: string, files: string[]) => string | Promise<string>;
}

/** Default concern bucket: the directory a file lives in (its second-level dir when nested). */
function defaultGroupBy(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 3) return parts.slice(0, 2).join("/");
  return parts[0] ?? file;
}

function defaultMessage(bucket: string, files: string[]): string {
  const list = files.map((f) => `- ${f}`).join("\n");
  return `${bucket}: update ${files.length} file${files.length === 1 ? "" : "s"}\n\n${list}\n`;
}

export function createGitManager(opts: GitManagerOptions): GitManager {
  const run = opts.run ?? spawnRunner;
  const { repoRoot } = opts;
  const trace = opts.traceBranch;
  const clean = opts.cleanBranch;
  const groupBy = opts.groupBy ?? defaultGroupBy;
  const messageFor = opts.messageFor ?? defaultMessage;

  const ensure = async (): Promise<void> => {
    const head = await revParse(run, repoRoot, "HEAD"); // requires at least one commit on the repo
    for (const branch of [trace, clean]) {
      if (!(await branchExists(run, repoRoot, branch))) {
        await git(run, repoRoot, ["update-ref", `refs/heads/${branch}`, head]);
      }
    }
  };

  return {
    async ensureBranches(_name: string): Promise<BranchPair> {
      await ensure();
      return { trace, clean };
    },

    async commitWrite(file: string, o: { sessionId: string; mode: GitMode }): Promise<void> {
      await ensure();
      const message = `trace: ${relPath(repoRoot, file)}\n\nsession ${o.sessionId}\n`;
      await commitFilesToBranch(run, repoRoot, trace, [file], message);
    },

    async planPromotion(_repoRoot: string, since: string): Promise<CommitSet[]> {
      const out = await git(run, repoRoot, ["diff", "--name-only", `${since}..${trace}`]);
      const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
      const buckets = new Map<string, string[]>();
      for (const f of files) {
        const key = groupBy(f);
        const arr = buckets.get(key) ?? [];
        arr.push(f);
        buckets.set(key, arr);
      }
      const sets: CommitSet[] = [];
      for (const [bucket, bucketFiles] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        sets.push({ files: bucketFiles, message: await messageFor(bucket, bucketFiles), rationale: `changes under ${bucket}` });
      }
      return sets;
    },

    async promote(sets: CommitSet[], mode: GitMode): Promise<void> {
      // suggest → surface only: the caller has the plan; nothing is applied to the clean branch.
      if (mode === "suggest") return;
      await ensure();
      for (const set of sets) {
        const abs = set.files.map((f) => (isAbsolute(f) ? f : join(repoRoot, f)));
        await commitFilesToBranch(run, repoRoot, clean, abs, set.message);
      }
    },

    async conflicts(_repoRoot: string): Promise<string[]> {
      const out = await git(run, repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    },
  };
}
