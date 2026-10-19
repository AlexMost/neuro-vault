import type { CorpusIdentity, RecordedIdentity } from './identity.js';
import type { CorpusShard } from './types.js';

/** What a nearest query is anchored on: a raw vector, or a note already in the corpus. */
export type CorpusAnchor = { vector: ArrayLike<number> } | { path: string };

export interface INoteHit {
  path: string;
  similarity: number;
}

export interface IBlockHit {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
}

export interface INearestOptions {
  threshold: number;
  limit?: number;
  /** Restrict candidates to these paths. */
  allowed?: readonly string[];
  /** Drop these paths from the candidates. */
  exclude?: readonly string[];
}

export interface INearestBlocksOptions {
  /** The notes whose blocks are candidates. */
  paths: readonly string[];
  threshold: number;
  limit?: number;
}

/** Similarity queries over a model's corpus, wherever it lives. */
export interface ICorpusReader {
  /** One list per anchor, in order; null for a path anchor whose note has no vector. */
  nearest(anchors: readonly CorpusAnchor[], opts: INearestOptions): Promise<(INoteHit[] | null)[]>;
  nearestBlocks(
    anchors: readonly CorpusAnchor[],
    opts: INearestBlocksOptions,
  ): Promise<(IBlockHit[] | null)[]>;
}

/** A record's change-detection metadata: all reconcile needs to decide what to re-embed. */
export interface ICorpusEntry {
  content_hash: string;
  mtime: number;
  size: number;
}

/** The durable side of a corpus: what reconcile reads and writes. */
export interface ICorpusWriter {
  entries(): Promise<Map<string, ICorpusEntry>>;
  upsert(record: CorpusShard): Promise<void>;
  /** False when the corpus has no record for `path` (the caller re-embeds). */
  touch(path: string, stat: { mtime: number; size: number }): Promise<boolean>;
  delete(path: string): Promise<void>;
  /** The identity on record; null when there is none, or none that can be read. */
  identity(): Promise<RecordedIdentity | null>;
  /**
   * ADR-0019's `identity()` + `reset(identity)`, composed inside the
   * implementation: whether the records it holds survive depends on what it
   * holds (records with no identity on record are of unknown provenance).
   * Leaves the corpus carrying `expected`; `rebuilt` means records were
   * discarded, and `previous` is what was on record before.
   */
  ensureIdentity(
    expected: CorpusIdentity,
  ): Promise<{ rebuilt: boolean; previous: RecordedIdentity | null }>;
  /** Re-reads the durable form after another writer; a no-op where nothing else writes it. */
  refresh(): Promise<void>;
}

/**
 * A model's corpus as the vault entry owns it: the reads, the writes, and the
 * lifecycle around them. The vault entry and the reconcile loop see only this,
 * never how or where the records are kept.
 */
export interface ICorpus extends ICorpusReader, ICorpusWriter {
  /** Brings the records into memory (or opens the store); reads and `entries()` need it. */
  load(): Promise<void>;
  readonly loaded: boolean;
  /** Notes with a vector: the ones that can rank. Needs a loaded corpus. */
  size(): number;
  vectorOf(path: string): Float32Array | null;
  /** Frees what `load()` took; the records themselves stay. */
  dispose(): void;
}
