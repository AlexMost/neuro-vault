import type { ICorpusReader } from '../src/lib/obsidian/corpus/corpus.js';
import { ShardCorpus } from '../src/lib/obsidian/corpus/shard-corpus.js';
import type { ShardStore } from '../src/lib/obsidian/corpus/shard-store.js';
import type { CorpusShard, SmartSource } from '../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../src/lib/obsidian/corpus/vector-codec.js';

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
