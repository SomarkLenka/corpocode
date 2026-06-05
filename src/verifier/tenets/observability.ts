import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const observabilityCheck: TenetCheck = {
  tenet: "O",
  name: "observability:metrics-and-readiness",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-observability",
};
