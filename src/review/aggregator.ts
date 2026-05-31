// Format the design-review concerns for injection before the model commits to an approach. Only the
// concerns (ok===false) are surfaced — a clean lens needs no words.
import type { TenetFinding } from "../molar/types";

export function summarizeReview(concerns: TenetFinding[]): string {
  if (concerns.length === 0) return "";
  return concerns
    .map((f) => `- [${f.tenet}] ${f.message}${f.severity === "block" ? " (blocking concern)" : ""}`)
    .join("\n");
}
