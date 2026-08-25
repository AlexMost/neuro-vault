import { describe, expect, it } from 'vitest';

import { loadCorpusSnapshot } from '../../../../src/lib/obsidian/corpus/snapshot.js';
import { encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';
import type { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';

function shard(
  path: string,
  embedding: string | null,
  blocks: CorpusShard['blocks'] = [],
): CorpusShard {
  return { path, content_hash: 'h', mtime: 1, size: 1, embedding, blocks };
}

function storeWith(shards: CorpusShard[]): CorpusStore {
  return {
    listShards: async () => new Map(shards.map((s) => [s.path, s])),
  } as unknown as CorpusStore;
}

describe('loadCorpusSnapshot', () => {
  it('decodes a shard into a source with its blocks', async () => {
    const snap = await loadCorpusSnapshot(
      storeWith([
        shard('Notes/a.md', encodeVector([0.5, 0.25]), [
          { key: '#Top', heading: 'Top', lines: [1, 4], embedding: encodeVector([0.125, 0]) },
        ]),
      ]),
    );
    const source = snap.sources.get('Notes/a.md');
    expect(source?.embedding).toEqual([0.5, 0.25]);
    expect(source?.blocks[0]).toMatchObject({ key: '#Top', heading: 'Top', lines: [1, 4] });
    expect(source?.blocks[0].embedding).toEqual([0.125, 0]);
  });

  it('skips a note with no note-level vector', async () => {
    const snap = await loadCorpusSnapshot(storeWith([shard('Notes/tiny.md', null)]));
    expect(snap.sources.size).toBe(0);
  });

  it('indexes basenames of the notes it kept', async () => {
    const snap = await loadCorpusSnapshot(storeWith([shard('Notes/a.md', encodeVector([1]))]));
    expect(snap.basenameIndex.resolve('a')).toBe('Notes/a.md');
  });

  it('returns an empty snapshot rather than throwing on an empty corpus', async () => {
    const snap = await loadCorpusSnapshot(storeWith([]));
    expect(snap.sources.size).toBe(0);
    expect(snap.basenameIndex.resolve('a')).toBeNull();
  });
});
