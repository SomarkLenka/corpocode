import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const testingCheck: TenetCheck = {
  tenet: "T",
  name: "testing:regression-and-failure-paths",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-testing",
};
