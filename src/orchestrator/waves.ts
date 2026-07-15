// Topological waves from dependsOn edges; within a wave, tasks with overlapping file paths
// are deferred to a later wave so parallel writers never share a surface. Pure.

export interface WaveTask {
  id: string;
  dependsOn: string[];
  files: string[];
}

export type WavesResult = { ok: true; waves: string[][] } | { ok: false; error: string };

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/";

/** True when either path is a prefix of the other (directory containment or same file). */
function overlaps(a: string[], b: string[]): boolean {
  for (const x of a.map(norm)) {
    for (const y of b.map(norm)) {
      if (x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}

export function computeWaves(tasks: WaveTask[]): WavesResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) return { ok: false, error: `task ${task.id}: unknown dependency "${dep}"` };
    }
  }

  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = tasks.map((t) => t.id);

  while (remaining.length > 0) {
    const ready = remaining.filter((id) => byId.get(id)!.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      return { ok: false, error: `dependency cycle among: ${remaining.join(", ")}` };
    }
    const batch: string[] = [];
    for (const id of ready) {
      const task = byId.get(id)!;
      if (batch.some((b) => overlaps(byId.get(b)!.files, task.files))) continue; // defer to a later wave
      batch.push(id);
    }
    waves.push(batch);
    for (const id of batch) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return { ok: true, waves };
}
