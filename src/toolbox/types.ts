// The toolbox is CorpoCode's gated catalog of the user's skills and agents: their "when to use" is
// stripped from the main model's context (so it stops auto-selecting and stops bloating context), and
// CorpoCode hands them back by name when its classifier judges them relevant. These are the shapes the
// gate writes and the classifier reads.
export type ToolboxKind = "agent" | "skill";
export type ToolboxScope = "user" | "project" | "plugin";

export interface ToolboxEntry {
  kind: ToolboxKind;
  name: string;
  scope: ToolboxScope;
  absPath: string; // the in-place (gated) file
  description: string; // the ORIGINAL "when to use", preserved for the classifier
  model?: string;
  backupRel?: string; // path under the restore dir holding the un-gated original (for restore)
}

export interface ToolboxCatalog {
  entries: ToolboxEntry[];
}
