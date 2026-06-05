import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const maintainabilityCheck: TenetCheck = {
  tenet: "M",
  name: "maintainability:isolated-and-honest",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-maintainability",
};
