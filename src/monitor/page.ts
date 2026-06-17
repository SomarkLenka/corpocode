// Where the monitor's page lives on disk. Resolved in ONE place so the deferred "inline into the
// bundle" change (see the design doc) is a single-file edit. Today the page is a separate static
// file served from the repo's src tree: the shipped binary is bin/corpocode.js, so from its dir the
// page is ../src/monitor/app.html. `corpocode monitor` is therefore meant to be run from a built
// repo checkout until the page is inlined.
import { join } from "node:path";

export function monitorPagePath(): string {
  return join(__dirname, "..", "src", "monitor", "app.html");
}
