import { buildBasenameIndex } from '../link-resolver.js';
import type { CorpusSnapshot } from '../semantic-backend.js';
import type { CorpusShard, SmartSource } from './types.js';
import type { CorpusStore } from './shard-store.js';
import { decodeVector } from './vector-codec.js';

/**
 * Decodes the whole corpus into the shape the ranking code consumes. A note
 * below the size gate carries no note vector and cannot participate in note
 * ranking, so it contributes no source — same rule the replaced loader applied.
 *
 * `shards` lets a caller that has already listed the corpus hand that listing
 * over instead of paying for a second full read and parse of every shard file.
 *
 * `isExcluded` applies the vault's scope at decode time. The corpus on disk is
 * only brought into agreement with the scope by a reconcile pass (which sweeps
 * out-of-scope shards as orphans), so between a scope change and the pass that
 * acts on it — and after a shard deletion that failed — the stored corpus can
 * still name a note the vault no longer exposes. Filtering here, rather than at
 * each tool, keeps `sources` and `basenameIndex` consistent and means no
 * ranking path can see an excluded note.
 */
export async function loadCorpusSnapshot(
  store: CorpusStore,
  opts: {
    shards?: Map<string, CorpusShard>;
    isExcluded?: (relPath: string) => boolean;
  } = {},
): Promise<CorpusSnapshot> {
  const listing = opts.shards ?? (await store.listShards());
  const sources = new Map<string, SmartSource>();
  for (const shard of listing.values()) {
    if (shard.embedding === null) continue;
    if (opts.isExcluded?.(shard.path)) continue;
    sources.set(shard.path, {
      path: shard.path,
      embedding: decodeVector(shard.embedding),
      blocks: shard.blocks.map((b) => ({
        key: b.key,
        heading: b.heading,
        lines: b.lines,
        embedding: decodeVector(b.embedding),
      })),
    });
  }
  return { sources, basenameIndex: buildBasenameIndex(sources.keys()) };
}
