// Minimal {{placeholder}} interpolation for editable prompts. Each {{name}} is replaced with vars[name];
// an unknown placeholder is left intact on purpose — that way a user who deletes a placeholder the code
// needs sees it sitting in the rendered prompt rather than getting a silent empty string. Whitespace
// inside the braces is tolerated ({{ name }}). Nothing here throws.
export function renderTemplate(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

/** The placeholder names a template references, in first-seen order — used by docs/validation. */
export function templateVars(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) names.add(m[1]!);
  return [...names];
}
