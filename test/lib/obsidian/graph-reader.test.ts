import { describe, expect, it, vi } from 'vitest';

import { createGraphReader } from '../../../src/lib/obsidian/graph-reader.js';
import type { ReadNotesInput, VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { makeVaultGraph } from '../../_vault-graph.js';

/** `a.md` and `b.md` link `[[Alpha]]`; `a.md` also links a note that does not exist. */
const NOTES: Record<string, string> = {
  'a.md': 'see [[Alpha]] and [[Nowhere]]',
  'b.md': 'also [[Alpha]]',
  'notes/Alpha.md': 'the target',
};

function stubReader(notes: Record<string, string>): VaultReader {
  return {
    scan: async () => Object.keys(notes).sort(),
    readNotes: async (input: ReadNotesInput) =>
      input.paths.map((path) => ({ path, frontmatter: null, content: notes[path] ?? '' })),
  };
}

const realGraph = () => new WikilinkGraphIndex({ reader: stubReader(NOTES) });

describe('createGraphReader', () => {
  it('answers backlink counts in request order, 0 for a note the graph lacks', async () => {
    const graph = realGraph();
    const reader = createGraphReader(() => graph);
    await expect(
      reader.backlinkCounts(['b.md', 'missing.md', 'notes/Alpha.md', 'notes/Alpha.md']),
    ).resolves.toEqual([0, 0, 2, 2]);
  });

  it('resolves targets in request order, null for none', async () => {
    const graph = realGraph();
    await expect(createGraphReader(() => graph).resolve(['Alpha', 'Nowhere'])).resolves.toEqual([
      'notes/Alpha.md',
      null,
    ]);
  });

  it("answers a note's links, and none for a note the graph lacks", async () => {
    const graph = realGraph();
    const reader = createGraphReader(() => graph);
    await expect(reader.noteLinks('a.md')).resolves.toEqual({
      incoming: [],
      outgoing: [
        { target: 'Alpha', resolved: true, path: 'notes/Alpha.md' },
        { target: 'Nowhere', resolved: false },
      ],
    });
    await expect(reader.noteLinks('missing.md')).resolves.toEqual({ incoming: [], outgoing: [] });
  });

  it('answers empty lists for empty input', async () => {
    const graph = realGraph();
    const reader = createGraphReader(() => graph);
    await expect(reader.backlinkCounts([])).resolves.toEqual([]);
    await expect(reader.resolve([])).resolves.toEqual([]);
  });

  it('reads the current graph once and freshens it once per call', async () => {
    const graph = makeVaultGraph();
    const current = vi.fn(() => graph);
    const reader = createGraphReader(current);
    await reader.noteLinks('a.md');
    await reader.backlinkCounts(['a.md', 'b.md']);
    await reader.resolve(['A', 'B']);
    expect(current).toHaveBeenCalledTimes(3);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(3);
  });

  it('answers one call from one graph; a swap reaches the next call', async () => {
    const first = makeVaultGraph({ getBacklinkCount: vi.fn(() => 1) });
    const second = makeVaultGraph({ getBacklinkCount: vi.fn(() => 2) });
    const graphs = [first, second];
    const reader = createGraphReader(() => graphs.shift() ?? second);
    await expect(reader.backlinkCounts(['a.md', 'b.md'])).resolves.toEqual([1, 1]);
    expect(first.getBacklinkCount).toHaveBeenCalledTimes(2);
    expect(second.getBacklinkCount).not.toHaveBeenCalled();
    await expect(reader.backlinkCounts(['a.md'])).resolves.toEqual([2]);
  });

  it('rejects a read with the refresh error as is', async () => {
    const failure = new Error('scan failed');
    const graph = makeVaultGraph({ ensureFresh: vi.fn(async () => Promise.reject(failure)) });
    const reader = createGraphReader(() => graph);
    await expect(reader.backlinkCounts(['a.md'])).rejects.toBe(failure);
    expect(graph.getBacklinkCount).not.toHaveBeenCalled();
  });
});
