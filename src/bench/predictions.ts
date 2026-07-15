// SWE-bench predictions adapter — pure. Turns our internal per-instance results into the
// predictions JSONL the SWE-bench harness ingests. SWE-bench requires the first three snake_case
// keys per entry (instance_id, model_name_or_path, model_patch); cost_usd/resolved are our own
// annotations, carried through only when present. The caller owns file IO — these are pure
// string/data transforms with no clock or randomness.

export interface PredictionInput {
  instanceId: string;
  patch: string;
  costUsd?: number;
  resolved?: boolean;
}

export interface PredictionEntry {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
  cost_usd?: number;
  resolved?: boolean;
}

/** One SWE-bench prediction entry per input, in input order. */
export function buildPredictions(inputs: PredictionInput[], modelName: string): PredictionEntry[] {
  return inputs.map((input) => {
    const entry: PredictionEntry = {
      instance_id: input.instanceId,
      model_name_or_path: modelName,
      model_patch: input.patch,
    };
    if (input.costUsd !== undefined) entry.cost_usd = input.costUsd;
    if (input.resolved !== undefined) entry.resolved = input.resolved;
    return entry;
  });
}

/** One JSON object per line, newline-terminated. Empty input → "". Pure; caller writes the file. */
export function toJsonl(entries: PredictionEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
