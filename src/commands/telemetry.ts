// `corpocode telemetry on|off|preview` — the user's controls over telemetry, designed so consent is
// informed and the payload is inspectable. `on` explains exactly what is and isn't collected before
// flipping the switch; `preview` prints the precise payload that would be sent, so a skeptical user can
// verify for themselves that it carries only whitelisted aggregate fields; `off` is the default state.
import { readFileSync, writeFileSync } from "node:fs";
import { configFile, corpocodeHome, ensureDir, logFile } from "../config/paths";
import { loadConfig } from "../config/load";
import { buildTelemetryPayload, TELEMETRY_FIELDS } from "../telemetry/whitelist";

const NEVER_COLLECTED =
  "prompts, code, file contents, file paths, transcripts, memory contents, and repository identity";

function readRawConfig(env?: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFile(env), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // no config yet → start from empty; loadConfig fills defaults elsewhere
  }
}

/** Merge the telemetry block into the user's raw config file, preserving everything else verbatim. */
function setTelemetryEnabled(enabled: boolean, env?: NodeJS.ProcessEnv): void {
  const raw = readRawConfig(env);
  const tel = (raw.telemetry && typeof raw.telemetry === "object" ? raw.telemetry : {}) as Record<string, unknown>;
  raw.telemetry = { ...tel, enabled };
  ensureDir(corpocodeHome(env));
  writeFileSync(configFile(env), `${JSON.stringify(raw, null, 2)}\n`);
}

function readLogLines(env?: NodeJS.ProcessEnv): string[] {
  try {
    return readFileSync(logFile(env), "utf8").split("\n");
  } catch {
    return [];
  }
}

export function runTelemetryCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const sub = argv[0];

  if (sub === "on") {
    process.stdout.write(
      "Enabling telemetry. CorpoCode will transmit ONLY these aggregate, non-identifying fields:\n" +
        `  ${TELEMETRY_FIELDS.join(", ")}\n` +
        `It will NEVER collect: ${NEVER_COLLECTED}.\n` +
        "Set telemetry.endpoint in your config to choose where it is sent. Preview anytime with `corpocode telemetry preview`.\n",
    );
    setTelemetryEnabled(true, env);
    process.stdout.write("Telemetry is now ON.\n");
    return;
  }

  if (sub === "off") {
    setTelemetryEnabled(false, env);
    process.stdout.write("Telemetry is now OFF. No data will be transmitted.\n");
    return;
  }

  if (sub === "preview") {
    const config = loadConfig({ env });
    const payload = buildTelemetryPayload(readLogLines(env), config);
    process.stdout.write("This is the EXACT payload that would be sent (only whitelisted aggregate fields):\n");
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const config = loadConfig({ env });
  process.stdout.write(`Telemetry is ${config.telemetry.enabled ? "ON" : "OFF"}.\n`);
  process.stdout.write("Usage: corpocode telemetry <on|off|preview>\n");
}
