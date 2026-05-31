import type { TenetCheck } from "../../molar/types";
import { isUi } from "./patterns";

// Responsiveness is the one tenet scoped to UI files only — its strictness defaults to
// off_for_non_ui, and `appliesTo` enforces that so it never fires on backend code.
export const responsivenessCheck: TenetCheck = {
  tenet: "R",
  name: "responsiveness:accessible-and-structural",
  appliesTo: (file) => isUi(file.path),
  prompt:
    "Assess Responsiveness (R) for this UI file: does it work at a ≤375px viewport, is every flow " +
    "completable by keyboard alone, does every image carry meaningful alt and every control an " +
    "associated <label>, is color reinforced by text/icon/pattern rather than being the sole " +
    "signal, and does any API return structure (blocks/types) rather than presentation (HTML/CSS)? " +
    "Flag desktop-only layouts, click handlers on non-focusable elements, missing alt/labels, and " +
    "color-only signals.",
};
