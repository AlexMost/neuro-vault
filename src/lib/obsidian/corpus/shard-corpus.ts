import type {
  IBlockHit,
  ICorpus,
  CorpusAnchor,
  ICorpusEntry,
  INearestBlocksOptions,
  INearestOptions,
  INoteHit,
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
import { decodeVector, encodeVector } from './vector-codec.js';

interface IResident {
  entry: ICorpusEntry;
  /** null for a note below the size gate: it has a record but takes no part in ranking. */
  vector: Float32Array | null;
  blocks: SmartBlock[];
}

/** Notes decoded between two yields while loading. */
const LOAD_YIELD_EVERY = 256;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function residentOf(shard: CorpusShard): IResident {
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

/** The record a resident was decoded from: float32 survives the round trip exactly. */
function shardOf(notePath: string, { entry, vector, blocks }: IResident): CorpusShard {
  return {
    path: notePath,
    content_hash: entry.content_hash,
    mtime: entry.mtime,
    size: entry.size,
    embedding: vector === null ? null : encodeVector(Array.from(vector)),
    blocks: blocks.map((b) => ({
      key: b.key,
      heading: b.heading,
      lines: b.lines,
      embedding: encodeVector(Array.from(b.embedding)),
    })),
  };
}

/**
 * The vector an anchor stands for; null when a path anchor has none. Resolved
 * from the map the read captured, not the live one: a read yields between
 * anchors, and a refresh or dispose meanwhile must not change its view.
 */
function queryOf(anchor: CorpusAnchor, memory: Map<string, IResident>): ArrayLike<number> | null {
  return 'vector' in anchor ? anchor.vector : (memory.get(anchor.path)?.vector ?? null);
}

/**
 * The in-memory {@link ICorpus} over a {@link ShardStore}: every write goes to the shard files
 * first and to memory only once that write resolved, so memory never claims more than disk holds.
 * Ranking is the brute-force scan the session path runs (same scoring, same ordering), with
 * `allowed` / `exclude` applied before `limit`.
 */
export class ShardCorpus implements ICorpus {
  private memory: Map<string, IResident> | null = null;
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
    const next = new Map<string, IResident>();
    let sinceYield = 0;
    for (const [notePath, shard] of await this.store.listShards()) {
      next.set(notePath, residentOf(shard));
      if (++sinceYield % LOAD_YIELD_EVERY === 0) await this.yieldEvery();
    }
    // Swapped in whole, so a read racing the load sees the old corpus or the new, never a half.
    this.memory = next;
  }

  async refresh(): Promise<void> {
    // No manifest under a loaded corpus: `index --prune` removed the directory, or the manifest
    // is unreadable. There is nothing to reload from, so memory keeps serving and the next
    // ensureIdentity writes it back (or, over shards of unknown provenance, rebuilds).
    if (this.memory !== null && (await this.store.readManifest()) === null) return;
    await this.load();
  }

  dispose(): void {
    this.memory = null;
  }

  vectorOf(notePath: string): Float32Array | null {
    return this.resident().get(notePath)?.vector ?? null;
  }

  async nearest(
    anchors: readonly CorpusAnchor[],
    opts: INearestOptions,
  ): Promise<(INoteHit[] | null)[]> {
    const memory = this.resident();
    const allowed = opts.allowed === undefined ? null : new Set(opts.allowed);
    const exclude = new Set(opts.exclude);
    const results: (INoteHit[] | null)[] = [];
    for (const [index, anchor] of anchors.entries()) {
      if (index > 0) await this.yieldEvery();
      const query = queryOf(anchor, memory);
      if (query === null) {
        results.push(null);
        continue;
      }
      const hits: INoteHit[] = [];
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
    opts: INearestBlocksOptions,
  ): Promise<(IBlockHit[] | null)[]> {
    const memory = this.resident();
    const results: (IBlockHit[] | null)[] = [];
    for (const [index, anchor] of anchors.entries()) {
      if (index > 0) await this.yieldEvery();
      const query = queryOf(anchor, memory);
      if (query === null) {
        results.push(null);
        continue;
      }
      const hits: IBlockHit[] = [];
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

  entries(): Promise<Map<string, ICorpusEntry>> {
    try {
      const entries = new Map<string, ICorpusEntry>();
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
    // No manifest and no shards under a loaded corpus: `index --prune` removed the directory
    // this corpus serves. Memory is what was there, so it goes back to disk: reconcile compares
    // notes against memory, so each would be `reused` with nothing on disk behind it.
    else if (result.previous === null && this.memory !== null && this.memory.size > 0) {
      await this.writeBack(this.memory);
    }
    return result;
  }

  /** Writes every resident's record, after the manifest ensureManifest just wrote. */
  private async writeBack(memory: Map<string, IResident>): Promise<void> {
    let sinceYield = 0;
    for (const [notePath, resident] of memory) {
      await this.store.writeShard(shardOf(notePath, resident));
      if (++sinceYield % LOAD_YIELD_EVERY === 0) await this.yieldEvery();
    }
  }

  private resident(): Map<string, IResident> {
    if (this.memory === null) throw new Error('corpus not loaded');
    return this.memory;
  }
}
