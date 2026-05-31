import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const loggingCheck: TenetCheck = {
  tenet: "L",
  name: "logging:structured-and-actionable",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Logging (L): are errors logged once, at the layer that handles them, with structured, " +
    "actionable context (what failed, where, why, what to check next)? Flag bare catch blocks that " +
    "swallow errors, console.log debug statements, unstructured string logs, and any logging of " +
    "secrets or PII.",
};
