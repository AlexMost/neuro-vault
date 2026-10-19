import type { ICorpusEntry, ICorpusWriter } from './corpus.js';
import type { ShardStore } from './shard-store.js';

/**
 * A {@link ICorpusWriter} over a {@link ShardStore} alone: every call goes to disk, and nothing is
 * held in memory. It serves callers with no resident corpus to keep in step (`neuro-vault-mcp
 * index`, a reconcile run in isolation).
 */
export function shardWriter(store: ShardStore): ICorpusWriter {
  return {
    async entries() {
      const entries = new Map<string, ICorpusEntry>();
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
    async ensureIdentity(expected) {
      const result = await store.ensureManifest(expected);
      // As ShardCorpus does: a corpus kept inside the vault stays out of its git history.
      await store.ensureGitignored();
      return result;
    },
    // Disk is the only copy, so there is nothing to bring up to date.
    refresh: () => Promise.resolve(),
  };
}
