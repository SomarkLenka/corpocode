// Embeddings for memory recall. The interface lets a provider-backed embedder be wired later
// (Phase 2+), but the default is a dependency-free, deterministic local embedder so recall works
// offline and tests are reproducible — and a turn never blocks on a remote embedding service
// (the In-flight tenet). It uses the hashing trick: tokens are hashed into a fixed-dimension
// signed vector, then L2-normalized so cosine similarity is a plain dot product.

export interface Embedder {
  readonly id: string;
  embed(text: string): Promise<number[]>;
}

const DEFAULT_DIM = 256;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Deterministic offline embedding of one string. */
export function embedText(text: string, dim = DEFAULT_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const tok of tokens) {
    const h = hash32(tok);
    const idx = h % dim;
    const sign = ((h >> 16) & 1) === 0 ? 1 : -1; // signed hashing reduces collision bias
    vec[idx]! += sign;
  }
  return l2normalize(vec);
}

export function localEmbedder(dim = DEFAULT_DIM): Embedder {
  return {
    id: "local-hash",
    embed: async (text) => embedText(text, dim),
  };
}

/** Cosine similarity. Both inputs are assumed L2-normalized, so this is their dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
