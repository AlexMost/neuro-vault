import type {
  BlockHit,
  Corpus,
  CorpusAnchor,
  CorpusEntry,
  NearestBlocksOptions,
  NearestOptions,
  NoteHit,
} from './corpus.js';
import type { CorpusIdentity } from './identity.js';
import {
  compareBlockHits,
  compareNoteHits,
  cosineSimilarity,
  ensureSameDimensions,
} from './scoring.js';
import type { ShardStore } from './shard-store.js';
import type { CorpusShard, SmartBlock, StoredManifest } from './types.js';
import { decodeVector } from './vector-codec.js';

interface Resident {
  entry: CorpusEntry;
  /** null for a note below the size gate: it has a record but takes no part in ranking. */
  vector: Float32Array | null;
  blocks: SmartBlock[];
}

/** Notes decoded between two yields while loading. */
const LOAD_YIELD_EVERY = 256;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function residentOf(shard: CorpusShard): Resident {
  return {
    entry: { content_hash: shard.content_hash, mtime: shard.mtime, size: shard.size },
    vector: shard.embedding === null ? null : decodeVector(shard.embedding),
    blocks: shard.blocks.map((b) => ({
      key: b.key,
      heading: b.heading,
      lines: b.lines,
      embedding: decodeVector(b.embedding),
    })),
  };
}

/**
 * The in-memory {@link Corpus} over a {@link ShardStore}: every write goes to the shard files
 * first and to memory only once that write resolved, so memory never claims more than disk holds.
 * Ranking is the brute-force scan the session path runs (same scoring, same ordering), with
 * `allowed` / `exclude` applied before `limit`.
 */
export class ShardCorpus implements Corpus {
  private memory: Map<string, Resident> | null = null;
  private readonly yieldEvery: () => Promise<void>;

  constructor(
    private readonly store: ShardStore,
    deps: { yieldEvery?: () => Promise<void> } = {},
  ) {
    this.yieldEvery = deps.yieldEvery ?? yieldToEventLoop;
  }

  get loaded(): boolean {
    return this.memory !== null;
  }

  /** Notes with a vector: the ones that can rank. */
  size(): number {
    let count = 0;
    for (const resident of this.resident().values()) if (resident.vector !== null) count += 1;
    return count;
  }

  async load(): Promise<void> {
    const next = new Map<string, Resident>();
    let sinceYield = 0;
    for (const [notePath, shard] of await this.store.listShards()) {
      next.set(notePath, residentOf(shard));
      if (++sinceYield % LOAD_YIELD_EVERY === 0) await this.yieldEvery();
    }
    // Swapped in whole, so a read racing the load sees the old corpus or the new, never a half.
    this.memory = next;
  }

  refresh(): Promise<void> {
    return this.load();
  }

  dispose(): void {
    this.memory = null;
  }

  vectorOf(notePath: string): Float32Array | null {
    return this.resident().get(notePath)?.vector ?? null;
  }

  async nearest(
    anchors: readonly CorpusAnchor[],
    opts: NearestOptions,
  ): Promise<(NoteHit[] | null)[]> {
    const memory = this.resident();
    const allowed = opts.allowed === undefined ? null : new Set(opts.allowed);
    const exclude = new Set(opts.exclude);
    const results: (NoteHit[] | null)[] = [];
    for (const [index, anchor] of anchors.entries()) {
      if (index > 0) await this.yieldEvery();
      const query = this.queryOf(anchor);
      if (query === null) {
        results.push(null);
        continue;
      }
      const hits: NoteHit[] = [];
      for (const [notePath, { vector }] of memory) {
        if (vector === null || exclude.has(notePath)) continue;
        if (allowed !== null && !allowed.has(notePath)) continue;
        ensureSameDimensions(query, vector, 'Query vector', `Source vector for ${notePath}`);
        const similarity = cosineSimilarity(query, vector);
        if (similarity >= opts.threshold) hits.push({ path: notePath, similarity });
      }
      hits.sort(compareNoteHits);
      results.push(typeof opts.limit === 'number' ? hits.slice(0, opts.limit) : hits);
    }
    return results;
  }

  async nearestBlocks(
    anchors: readonly CorpusAnchor[],
    opts: NearestBlocksOptions,
  ): Promise<(BlockHit[] | null)[]> {
    const memory = this.resident();
    const results: (BlockHit[] | null)[] = [];
    for (const [index, anchor] of anchors.entries()) {
      if (index > 0) await this.yieldEvery();
      const query = this.queryOf(anchor);
      if (query === null) {
        results.push(null);
        continue;
      }
      const hits: BlockHit[] = [];
      for (const notePath of new Set(opts.paths)) {
        const resident = memory.get(notePath);
        // A note without a note vector is out of the corpus as the session path sees it, blocks too.
        if (resident === undefined || resident.vector === null) continue;
        for (const block of resident.blocks) {
          if (block.embedding.length === 0) continue;
          ensureSameDimensions(
            query,
            block.embedding,
            'Query vector',
            `Block vector for ${block.key}`,
          );
          const similarity = cosineSimilarity(query, block.embedding);
          if (similarity >= opts.threshold) {
            hits.push({ path: notePath, heading: block.heading, lines: block.lines, similarity });
          }
        }
      }
      hits.sort(compareBlockHits);
      results.push(typeof opts.limit === 'number' ? hits.slice(0, opts.limit) : hits);
    }
    return results;
  }

  entries(): Promise<Map<string, CorpusEntry>> {
    try {
      const entries = new Map<string, CorpusEntry>();
      for (const [notePath, { entry }] of this.resident()) entries.set(notePath, { ...entry });
      return Promise.resolve(entries);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async upsert(record: CorpusShard): Promise<void> {
    await this.store.writeShard(record);
    this.memory?.set(record.path, residentOf(record));
  }

  async touch(notePath: string, stat: { mtime: number; size: number }): Promise<boolean> {
    // Memory holds decoded vectors, not the encoded record a rewrite needs, so the shard is re-read.
    const shard = await this.store.readShard(notePath);
    if (shard === null) return false;
    await this.store.writeShard({ ...shard, mtime: stat.mtime, size: stat.size });
    const resident = this.memory?.get(notePath);
    if (resident !== undefined) resident.entry = { ...resident.entry, ...stat };
    return true;
  }

  async delete(notePath: string): Promise<void> {
    await this.store.deleteShard(notePath);
    this.memory?.delete(notePath);
  }

  identity(): Promise<StoredManifest | null> {
    return this.store.readManifest();
  }

  async ensureIdentity(
    expected: CorpusIdentity,
  ): Promise<{ rebuilt: boolean; previous: StoredManifest | null }> {
    const result = await this.store.ensureManifest(expected);
    // A rebuild cleared every shard, so the empty store is what memory now mirrors.
    if (result.rebuilt) this.memory = new Map();
    return result;
  }

  private resident(): Map<string, Resident> {
    if (this.memory === null) throw new Error('corpus not loaded');
    return this.memory;
  }

  /** The vector an anchor stands for; null when a path anchor has none. */
  private queryOf(anchor: CorpusAnchor): ArrayLike<number> | null {
    return 'vector' in anchor ? anchor.vector : this.vectorOf(anchor.path);
  }
}
