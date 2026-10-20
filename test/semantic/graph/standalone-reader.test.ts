import { describe, expect, it, vi } from 'vitest';

import { GraphReadError, type IGraphReader } from '../../../src/lib/obsidian/graph-reader.js';
import type { IVaultGraph } from '../../../src/lib/obsidian/wikilink-graph.js';
import { createStandaloneGraphReader } from '../../../src/modules/semantic/graph/index.js';

/** A graph holding `a.md → b.md`, whose `ensureFresh` does what `fresh` does. */
function stubGraph(fresh: () => Promise<void> = async () => {}): IVaultGraph {
  return {
    ensureFresh: vi.fn(fresh),
    getNoteLinks: (p) =>
      p === 'b.md'
        ? { incoming: [{ source: 'a.md' }], outgoing: [] }
        : { incoming: [], outgoing: [] },
    getBacklinkCount: (p) => (p === 'b.md' ? 1 : 0),
    resolve: (t) => (t === 'b' ? 'b.md' : null),
  };
}

const READS: Array<{ read: string; call: (g: IGraphReader) => Promise<unknown> }> = [
  { read: 'noteLinks', call: (g) => g.noteLinks('b.md') },
  { read: 'backlinkCounts', call: (g) => g.backlinkCounts(['b.md']) },
  { read: 'resolve', call: (g) => g.resolve(['b']) },
];

describe('createStandaloneGraphReader (--no-semantic)', () => {
  it('answers from the graph, refreshing it before each read', async () => {
    const graph = stubGraph();
    const reader = createStandaloneGraphReader(graph);

    expect(await reader.noteLinks('b.md')).toEqual({
      incoming: [{ source: 'a.md' }],
      outgoing: [],
    });
    expect(await reader.backlinkCounts(['b.md', 'a.md'])).toEqual([1, 0]);
    expect(await reader.resolve(['b', 'nowhere'])).toEqual(['b.md', null]);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(3);
  });

  it.each(READS)('a failed build fails $read as a GraphReadError', async ({ call }) => {
    const cause = new Error('scan failed');
    const reader = createStandaloneGraphReader(
      stubGraph(async () => {
        throw cause;
      }),
    );

    const error = await call(reader).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphReadError);
    expect((error as GraphReadError).message).toBe('graph read failed: scan failed');
    expect((error as GraphReadError).cause).toBe(cause);
  });

  it('passes a GraphReadError through as itself', async () => {
    const original = new GraphReadError('already a graph read failure');
    const reader = createStandaloneGraphReader(
      stubGraph(async () => {
        throw original;
      }),
    );

    await expect(reader.resolve(['b'])).rejects.toBe(original);
  });
});
