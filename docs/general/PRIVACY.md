# Privacy and telemetry

CorpoCode's telemetry is designed around a single constraint — **protect the user's data absolutely** —
rather than around what would be most informative to collect. The defaults and the design both follow
from that.

## Off by default, and off means off

Telemetry is **disabled** on every install. When it is off, CorpoCode makes **zero network requests of
any kind** across an entire turn — no ping, no update check, nothing. The hook handlers do not even
import the telemetry transport, so a normal turn cannot transmit anything regardless of configuration.

## Enabling it is a deliberate, informed act

Turn it on with `corpocode telemetry on`, which first prints exactly what will and will not be
collected. `corpocode doctor` then shows a banner whenever telemetry is on, so it is never silently
active.

## A whitelist, not a blacklist

Only an explicitly enumerated set of **aggregate, non-identifying** fields is ever transmitted — a
stronger guarantee than trying to strip sensitive data out of a richer payload. The collected fields
are counts and distributions:

- anonymized counts of hook invocations
- the distribution of model and effort choices
- the cost and estimated-savings figures
- the error rate
- which backends are in use
- latency percentiles (p50/p90/p99)

## Never collected

Prompts, code, file contents, file paths, transcripts, memory contents, and repository identity — none
of these is ever built into the payload, so there is nothing identifying to transmit.

## Inspect it yourself

Run `corpocode telemetry preview` to print the **exact** payload that would be sent, so you can verify
for yourself that it contains only the whitelisted aggregate fields. The transport is batched and
fail-open: a failed send is swallowed and never affects your turn.
