import type { CorpusEntry, CorpusWriter } from './corpus.js';
import type { ShardStore } from './shard-store.js';

/**
 * A {@link CorpusWriter} over a {@link ShardStore} alone: every call goes to disk, and nothing is
 * held in memory. It serves callers with no resident corpus to keep in step (`neuro-vault-mcp
 * index`, a reconcile run in isolation).
 */
export function shardWriter(store: ShardStore): CorpusWriter {
  return {
    async entries() {
      const entries = new Map<string, CorpusEntry>();
      for (const [path, shard] of await store.listShards()) {
        entries.set(path, {
          content_hash: shard.content_hash,
          mtime: shard.mtime,
          size: shard.size,
        });
      }
      return entries;
    },
    upsert: (record) => store.writeShard(record),
    async touch(path, stat) {
      const shard = await store.readShard(path);
      if (shard === null) return false;
      await store.writeShard({ ...shard, mtime: stat.mtime, size: stat.size });
      return true;
    },
    delete: (path) => store.deleteShard(path),
    identity: () => store.readManifest(),
    ensureIdentity: (expected) => store.ensureManifest(expected),
    // Disk is the only copy, so there is nothing to bring up to date.
    refresh: () => Promise.resolve(),
  };
}
