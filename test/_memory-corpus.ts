import type {
  CorpusAnchor,
  IBlockHit,
  ICorpus,
  ICorpusEntry,
  ICorpusReader,
  INearestBlocksOptions,
  INearestOptions,
  INoteHit,
} from '../src/lib/obsidian/corpus/corpus.js';
import {
  identityMatches,
  type CorpusIdentity,
  type RecordedIdentity,
} from '../src/lib/obsidian/corpus/identity.js';
import {
  compareBlockHits,
  compareNoteHits,
  cosineSimilarity,
} from '../src/lib/obsidian/corpus/scoring.js';
import { ShardCorpus } from '../src/lib/obsidian/corpus/shard-corpus.js';
import type { ShardStore } from '../src/lib/obsidian/corpus/shard-store.js';
import type { CorpusShard, SmartSource } from '../src/lib/obsidian/corpus/types.js';
import { decodeVector, encodeVector } from '../src/lib/obsidian/corpus/vector-codec.js';

/**
 * The shards a decoded note map stands for. An empty note vector is a note
 * below the size gate: a record with no vector, as the indexer writes it.
 */
export function shardsOf(sources: Map<string, SmartSource>): Map<string, CorpusShard> {
  const shards = new Map<string, CorpusShard>();
  for (const [notePath, source] of sources) {
    shards.set(notePath, {
      path: notePath,
      content_hash: `hash-${notePath}`,
      mtime: 1000,
      size: 100,
      embedding: source.embedding.length === 0 ? null : encodeVector(Array.from(source.embedding)),
      blocks: source.blocks.map((block) => ({
        key: block.key,
        heading: block.heading,
        lines: block.lines,
        embedding: encodeVector(Array.from(block.embedding)),
      })),
    });
  }
  return shards;
}

/**
 * A loaded {@link ShardCorpus} over `sources`, kept in memory: the real
 * ranking without a vault on disk. The store behind it only lists shards,
 * which is all `load()` reads; nothing here writes.
 */
export async function loadedCorpus(sources: Map<string, SmartSource>): Promise<ShardCorpus> {
  const shards = shardsOf(sources);
  const store = { listShards: () => Promise.resolve(shards) } as unknown as ShardStore;
  const corpus = new ShardCorpus(store, { yieldEvery: () => Promise.resolve() });
  await corpus.load();
  return corpus;
}

/**
 * {@link loadedCorpus} behind a synchronous constructor, for fakes built
 * where nothing can be awaited: the corpus loads on the first read.
 */
export function corpusOver(sources: Map<string, SmartSource>): ICorpusReader {
  let corpus: Promise<ShardCorpus> | undefined;
  const loaded = (): Promise<ShardCorpus> => (corpus ??= loadedCorpus(sources));
  return {
    nearest: async (anchors, opts) => (await loaded()).nearest(anchors, opts),
    nearestBlocks: async (anchors, opts) => (await loaded()).nearestBlocks(anchors, opts),
  };
}

/**
 * What a {@link MemoryCorpus} keeps "durably": the identity on record and the records, shared
 * between corpora built over it the way two processes share a store.
 */
export interface IMemoryStore {
  identity: RecordedIdentity | null;
  records: Map<string, CorpusShard>;
}

export function memoryStore(): IMemoryStore {
  return { identity: null, records: new Map() };
}

/**
 * A full {@link ICorpus} with no shard anywhere: the second implementation ADR-0019 promises, as
 * a test double. Shaped like a hosted store — every read and write goes straight to `store`, so
 * there is no resident copy to refresh, and `load()` only opens it. Ranking uses the same scores
 * and order as the shard corpus (`scoring.ts`).
 */
export class MemoryCorpus implements ICorpus {
  private open = false;

  constructor(readonly store: IMemoryStore = memoryStore()) {}

  get loaded(): boolean {
    return this.open;
  }

  load(): Promise<void> {
    this.open = true;
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.open = false;
  }

  size(): number {
    this.assertOpen();
    return [...this.store.records.values()].filter((r) => r.embedding !== null).length;
  }

  vectorOf(notePath: string): Float32Array | null {
    const embedding = this.store.records.get(notePath)?.embedding ?? null;
    return embedding === null ? null : decodeVector(embedding);
  }

  nearest(anchors: readonly CorpusAnchor[], opts: INearestOptions) {
    this.assertOpen();
    const allowed = opts.allowed === undefined ? null : new Set(opts.allowed);
    const exclude = new Set(opts.exclude);
    return Promise.resolve(
      anchors.map((anchor) => {
        const query = this.queryOf(anchor);
        if (query === null) return null;
        const hits: INoteHit[] = [];
        for (const notePath of this.store.records.keys()) {
          const vector = this.vectorOf(notePath);
          if (vector === null || exclude.has(notePath)) continue;
          if (allowed !== null && !allowed.has(notePath)) continue;
          const similarity = cosineSimilarity(query, vector);
          if (similarity >= opts.threshold) hits.push({ path: notePath, similarity });
        }
        hits.sort(compareNoteHits);
        return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
      }),
    );
  }

  nearestBlocks(anchors: readonly CorpusAnchor[], opts: INearestBlocksOptions) {
    this.assertOpen();
    return Promise.resolve(
      anchors.map((anchor) => {
        const query = this.queryOf(anchor);
        if (query === null) return null;
        const hits: IBlockHit[] = [];
        for (const notePath of new Set(opts.paths)) {
          const record = this.store.records.get(notePath);
          if (record === undefined || record.embedding === null) continue;
          for (const block of record.blocks) {
            const similarity = cosineSimilarity(query, decodeVector(block.embedding));
            if (similarity < opts.threshold) continue;
            hits.push({ path: notePath, heading: block.heading, lines: block.lines, similarity });
          }
        }
        hits.sort(compareBlockHits);
        return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
      }),
    );
  }

  entries(): Promise<Map<string, ICorpusEntry>> {
    const entries = new Map<string, ICorpusEntry>();
    for (const [notePath, { content_hash, mtime, size }] of this.store.records) {
      entries.set(notePath, { content_hash, mtime, size });
    }
    return Promise.resolve(entries);
  }

  upsert(record: CorpusShard): Promise<void> {
    this.store.records.set(record.path, record);
    return Promise.resolve();
  }

  touch(notePath: string, stat: { mtime: number; size: number }): Promise<boolean> {
    const record = this.store.records.get(notePath);
    if (record === undefined) return Promise.resolve(false);
    this.store.records.set(notePath, { ...record, ...stat });
    return Promise.resolve(true);
  }

  delete(notePath: string): Promise<void> {
    this.store.records.delete(notePath);
    return Promise.resolve();
  }

  identity(): Promise<RecordedIdentity | null> {
    return Promise.resolve(this.store.identity);
  }

  /**
   * Records with nothing on record are of unknown provenance, so they do not survive. A matching
   * identity is left as recorded, as the shard store leaves its manifest unwritten.
   */
  ensureIdentity(expected: CorpusIdentity) {
    const previous = this.store.identity;
    const hasRecords = this.store.records.size > 0;
    const matches = identityMatches(previous, expected);
    const keep = matches || (previous === null && !hasRecords);
    if (!keep) this.store.records.clear();
    if (!matches) this.store.identity = { ...expected };
    return Promise.resolve({ rebuilt: !keep && hasRecords, previous });
  }

  private queryOf(anchor: CorpusAnchor): ArrayLike<number> | null {
    return 'vector' in anchor ? anchor.vector : this.vectorOf(anchor.path);
  }

  private assertOpen(): void {
    if (!this.open) throw new Error('corpus not loaded');
  }
}
