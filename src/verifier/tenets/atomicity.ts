import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const atomicityCheck: TenetCheck = {
  tenet: "A",
  name: "atomicity:one-thing-per-unit",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Atomicity (A): does each unit in this file do ONE thing, named for that one thing in " +
    "five words or fewer, with a call graph that reads as a line rather than a tree of unrelated " +
    "conditionals? Flag functions/files that do several unrelated things, names containing 'and', " +
    "and junk-drawer modules.",
};
