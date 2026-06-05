import type { TenetCheck } from "../../molar/types";
import { isDoc, isSource } from "./patterns";

export const documentationCheck: TenetCheck = {
  tenet: "D",
  name: "documentation:why-not-what",
  appliesTo: (file) => isSource(file.path) || isDoc(file.path),
  promptId: "verifier-documentation",
};
