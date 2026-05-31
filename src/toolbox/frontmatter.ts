// Frontmatter read + gate for skill/agent files. A skill/agent starts with a `---` block of `key: value`
// lines; we read name/description/model and a `corpocode_gated` marker (idempotency), and we rewrite
// ONLY the description to the gating line while preserving every other key and the body verbatim. This
// is line-based (not a full YAML parser) on purpose: it's deterministic, dependency-free, and only ever
// touches the one line it must.
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY = /^([A-Za-z0-9_-]+):(.*)$/;

export interface ToolboxFrontmatter {
  hasFrontmatter: boolean;
  name?: string;
  description?: string;
  model?: string;
  gated: boolean;
}

interface Entry {
  key: string;
  lines: string[]; // the `key: ...` line plus any indented continuation lines
}

function splitEntries(block: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = KEY.exec(line);
    if (m && !/^\s/.test(line)) entries.push({ key: m[1]!, lines: [line] });
    else if (entries.length) entries[entries.length - 1]!.lines.push(line);
    else entries.push({ key: "", lines: [line] }); // junk before the first key — preserved
  }
  return entries;
}

/** The full value of a key: the text after the first colon, plus any continuation lines, joined. */
function valueOf(entries: Entry[], key: string): string | undefined {
  const e = entries.find((x) => x.key === key);
  if (!e) return undefined;
  const head = KEY.exec(e.lines[0]!)?.[2]?.trim() ?? "";
  const cont = e.lines.slice(1).map((l) => l.trim()).filter(Boolean).join(" ");
  return [head, cont].filter(Boolean).join(" ");
}

export function parseToolboxFrontmatter(text: string): ToolboxFrontmatter {
  const m = FENCE.exec(text);
  if (!m) return { hasFrontmatter: false, gated: false };
  const entries = splitEntries(m[1]!);
  const result: ToolboxFrontmatter = { hasFrontmatter: true, gated: valueOf(entries, "corpocode_gated") === "true" };
  const name = valueOf(entries, "name");
  const description = valueOf(entries, "description");
  const model = valueOf(entries, "model");
  if (name) result.name = name;
  if (description) result.description = description;
  if (model) result.model = model;
  return result;
}

export interface GateResult {
  text: string;
  originalDescription: string;
}

/**
 * Rewrite `description` → the gating line and add the `corpocode_gated: true` marker, preserving every
 * other key and the body. Returns null when there's no frontmatter or it is already gated (idempotent
 * no-op), so the caller treats null as "skip".
 */
export function applyGate(text: string, gating: string): GateResult | null {
  const m = FENCE.exec(text);
  if (!m) return null;
  const entries = splitEntries(m[1]!);
  if (valueOf(entries, "corpocode_gated") === "true") return null;
  const originalDescription = valueOf(entries, "description") ?? "";

  const descEntry = entries.find((e) => e.key === "description");
  if (descEntry) descEntry.lines = [`description: ${gating}`];
  else entries.push({ key: "description", lines: [`description: ${gating}`] });
  entries.push({ key: "corpocode_gated", lines: ["corpocode_gated: true"] });

  const fm = entries.flatMap((e) => e.lines).join("\n");
  return { text: `---\n${fm}\n---\n${m[2] ?? ""}`, originalDescription };
}
