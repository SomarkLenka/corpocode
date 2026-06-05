import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const extensibilityCheck: TenetCheck = {
  tenet: "E",
  name: "extensibility:swappable-behind-a-seam",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-extensibility",
};
