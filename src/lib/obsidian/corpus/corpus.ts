import type { CorpusIdentity } from './identity.js';
import type { CorpusShard, StoredManifest } from './types.js';

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
  identity(): Promise<StoredManifest | null>;
  /** ADR-0019's identity() + reset() composed as ShardStore.ensureManifest does today. */
  ensureIdentity(
    expected: CorpusIdentity,
  ): Promise<{ rebuilt: boolean; previous: StoredManifest | null }>;
  refresh(): Promise<void>;
}

export interface ICorpus extends ICorpusReader, ICorpusWriter {
  vectorOf(path: string): Float32Array | null;
  dispose(): void;
}
