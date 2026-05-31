import type { TenetCheck } from "../../molar/types";
import { isDoc, isSource } from "./patterns";

export const documentationCheck: TenetCheck = {
  tenet: "D",
  name: "documentation:why-not-what",
  appliesTo: (file) => isSource(file.path) || isDoc(file.path),
  prompt:
    "Assess Documentation (D): is the WHY recorded for any non-obvious choice (the constraint, the " +
    "alternative considered, the trade-off, an ADR link), do comments explain intent rather than " +
    "restate the code, and does this change leave no doc stale? Flag comments that merely restate " +
    "the line below, an ADR-worthy decision made with no durable record, and a doc the code now " +
    "contradicts.",
};
