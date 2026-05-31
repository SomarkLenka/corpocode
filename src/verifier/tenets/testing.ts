import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const testingCheck: TenetCheck = {
  tenet: "T",
  name: "testing:regression-and-failure-paths",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Testing (T): does a bug fix arrive with a regression test that fails WITHOUT the fix, " +
    "are failure paths (timeout, 5xx, malformed input) tested as deliberately as the happy path, " +
    "and do tests assert caller-visible behavior rather than internals or call counts? Flag new " +
    "logic with no test, untested error paths, and any .only/.skip shipped to main.",
};
