import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const loggingCheck: TenetCheck = {
  tenet: "L",
  name: "logging:structured-and-actionable",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-logging",
};
