// The DocGenerator contract. Two products per documented unit: a short inline doc comment, and a
// structured "what this code does" record that captures the things a reader can't recover from the
// code alone — what it impacts, what it touches (resolved through the KnowledgeGraph, never guessed),
// the risks, and the shape of its input/transformation/output. The record is persisted beside the
// code and refreshed when a change stales it (the D tenet: a doc that no longer matches reality is a
// bug). Declared in the master spec §6.4 / §7.3.

/** The structured record describing a single symbol's behavior and blast radius. */
export interface WhatCodeDoes {
  impacts: string[];
  touches: string[]; // resolved via KnowledgeGraph neighbors, not guessed
  risks: string[];
  futureConsiderations: string[];
  input: { params: string; structure: string; mutabilityIfChanged: string };
  transformation: { how: string; purpose: string };
  output: { structure: string; considerations: string };
}

/** A persisted record: the structured facets plus the inline docs, keyed by the signature it was
 * generated for so `refresh` can detect staleness cheaply. */
export interface DocRecord extends WhatCodeDoes {
  file: string;
  symbol: string;
  inlineDocs: string;
  signature: string; // the declaration this record describes; a change here stales the record
  generatedAt: number;
}

export interface DocGenerator {
  /** Inline comments + cross-references for a touched unit. */
  inlineDocs(file: string, symbol: string): Promise<string>;
  /** The structured what-code-does record, one cheap pass per facet. */
  whatCodeDoes(file: string, symbol: string): Promise<WhatCodeDoes>;
  /** Refresh records that a change has staled (D tenet: no stale docs). */
  refresh(changedFiles: string[]): Promise<void>;
}
