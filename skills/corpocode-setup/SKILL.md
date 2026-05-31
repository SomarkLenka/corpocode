---
name: setup
description: Provision and health-check CorpoCode's backends (graphify, OpenViking) after installing the plugin, then run diagnostics. Use once after installing CorpoCode, or when doctor reports a backend is unavailable.
---

# CorpoCode Setup

Installing the CorpoCode plugin registers its hooks but leaves provisioning to you, on purpose:
installation is inert; provisioning (which installs a Python toolchain and starts daemons) is a
deliberate act. Run this once after installing.

Steps:

1. Provision the backends (idempotent — safe to re-run):

   ```
   corpocode provision
   ```

   This installs graphify, registers its git hook so the graph stays fresh, builds the initial
   graph, generates OpenViking's config from your CorpoCode provider config, and starts the daemon.

2. Verify everything is wired and reachable:

   ```
   corpocode doctor
   ```

   Every red check prints the exact `corpocode install --repair` (or `provision`) remedy.

Until provisioning runs, CorpoCode is useful but degraded: graph-backed file scoring falls back to
a string-overlap heuristic, in keeping with the fail-open principle that governs the whole system.
