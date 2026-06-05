import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const inFlightCheck: TenetCheck = {
  tenet: "I",
  name: "in-flight:timeout-retry-fallback",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-in-flight",
};
