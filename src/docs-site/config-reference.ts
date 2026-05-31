// Generate the configuration reference FROM the Zod schema, never by hand (Phase 4 §5). The reference
// is derived from `configSchema.parse({})` — the canonical default object the schema itself produces —
// so every field, its type, and its default come straight from the source of truth. Add a config field
// and it appears here automatically; change a default and the doc changes with it. It cannot drift.
import { configSchema } from "../config/schema";

interface FieldRow {
  path: string;
  type: string;
  default: string;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function flatten(obj: Record<string, unknown>, prefix: string, rows: FieldRow[]): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, path, rows);
    } else {
      rows.push({ path, type: typeOf(value), default: JSON.stringify(value) });
    }
  }
}

export function generateConfigReference(): string {
  const defaults = configSchema.parse({}) as Record<string, unknown>;
  const rows: FieldRow[] = [];
  flatten(defaults, "", rows);
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const body = rows.map((r) => `| \`${r.path}\` | ${r.type} | \`${r.default}\` |`).join("\n");
  return (
    "# Configuration reference\n\n" +
    "_Generated from `src/config/schema.ts` — do not edit by hand._\n\n" +
    "Config lives at `~/.corpocode/config.json`. Every field has a default, so a partial config is " +
    "valid and missing fields take the values below. Unknown keys are ignored (forward/backward " +
    "tolerant).\n\n" +
    "| Field | Type | Default |\n| --- | --- | --- |\n" +
    `${body}\n`
  );
}
