import type {
  CorpusAnchor,
  IBlockHit,
  ICorpusReader,
  INearestBlocksOptions,
  INearestOptions,
  INoteHit,
} from '../../lib/obsidian/corpus/corpus.js';
import {
  compareBlockHits,
  compareNoteHits,
  cosineSimilarity,
  ensureSameDimensions,
} from '../../lib/obsidian/corpus/scoring.js';
import type { SmartSource } from './types.js';

function queryOf(
  anchor: CorpusAnchor,
  sources: Map<string, SmartSource>,
): ArrayLike<number> | null {
  if ('vector' in anchor) return anchor.vector;
  const source = sources.get(anchor.path);
  return source === undefined || source.embedding.length === 0 ? null : source.embedding;
}

/**
 * An {@link ICorpusReader} over a decoded snapshot, ranking exactly as `ShardCorpus` does:
 * same scoring and ordering, `allowed` / `exclude` before `limit`, null for a path anchor
 * without a vector. Temporary — it bridges the snapshot-backed backend until sessions read
 * the corpus through the vault entry.
 */
export function snapshotReader(sources: Map<string, SmartSource>): ICorpusReader {
  return {
    nearest(anchors: readonly CorpusAnchor[], opts: INearestOptions) {
      const allowed = opts.allowed === undefined ? null : new Set(opts.allowed);
      const exclude = new Set(opts.exclude);
      const results = anchors.map((anchor): INoteHit[] | null => {
        const query = queryOf(anchor, sources);
        if (query === null) return null;
        const hits: INoteHit[] = [];
        for (const [notePath, { embedding }] of sources) {
          if (embedding.length === 0 || exclude.has(notePath)) continue;
          if (allowed !== null && !allowed.has(notePath)) continue;
          ensureSameDimensions(query, embedding, 'Query vector', `Source vector for ${notePath}`);
          const similarity = cosineSimilarity(query, embedding);
          if (similarity >= opts.threshold) hits.push({ path: notePath, similarity });
        }
        hits.sort(compareNoteHits);
        return typeof opts.limit === 'number' ? hits.slice(0, opts.limit) : hits;
      });
      return Promise.resolve(results);
    },

    nearestBlocks(anchors: readonly CorpusAnchor[], opts: INearestBlocksOptions) {
      const results = anchors.map((anchor): IBlockHit[] | null => {
        const query = queryOf(anchor, sources);
        if (query === null) return null;
        const hits: IBlockHit[] = [];
        for (const notePath of new Set(opts.paths)) {
          const source = sources.get(notePath);
          if (source === undefined || source.embedding.length === 0) continue;
          for (const block of source.blocks) {
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
        return typeof opts.limit === 'number' ? hits.slice(0, opts.limit) : hits;
      });
      return Promise.resolve(results);
    },
  };
}

/**
 * A {@link snapshotReader} over a snapshot read on the first corpus call and
 * kept for the rest: a search that never reaches its semantic leg never reads
 * the snapshot, and one that does reads it once.
 */
export function lazySnapshotReader(
  snapshot: () => Promise<{ sources: Map<string, SmartSource> }>,
): ICorpusReader {
  let reader: Promise<ICorpusReader> | undefined;
  const load = (): Promise<ICorpusReader> =>
    (reader ??= snapshot().then(({ sources }) => snapshotReader(sources)));
  return {
    nearest: async (anchors, opts) => (await load()).nearest(anchors, opts),
    nearestBlocks: async (anchors, opts) => (await load()).nearestBlocks(anchors, opts),
  };
}
