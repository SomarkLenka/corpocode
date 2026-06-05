import type { TenetCheck } from "../../molar/types";
import { isUi } from "./patterns";

// Responsiveness is the one tenet scoped to UI files only — its strictness defaults to
// off_for_non_ui, and `appliesTo` enforces that so it never fires on backend code.
export const responsivenessCheck: TenetCheck = {
  tenet: "R",
  name: "responsiveness:accessible-and-structural",
  appliesTo: (file) => isUi(file.path),
  promptId: "verifier-responsiveness",
};
