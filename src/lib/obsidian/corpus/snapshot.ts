import { buildBasenameIndex } from '../link-resolver.js';
import type { CorpusSnapshot } from '../semantic-backend.js';
import type { SmartSource } from '../smart-connections-types.js';
import type { CorpusStore } from './shard-store.js';
import { decodeVector } from './vector-codec.js';

/**
 * Decodes the whole corpus into the shape the ranking code consumes. A note
 * below the size gate carries no note vector and cannot participate in note
 * ranking, so it contributes no source — same rule the replaced loader applied.
 */
export async function loadCorpusSnapshot(store: CorpusStore): Promise<CorpusSnapshot> {
  const sources = new Map<string, SmartSource>();
  for (const shard of (await store.listShards()).values()) {
    if (shard.embedding === null) continue;
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
