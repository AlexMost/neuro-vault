import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import type {
  ReadNotesInput,
  ReadNotesItem,
  VaultReader,
} from '../../../src/lib/obsidian/vault-reader.js';

interface FakeNote {
  frontmatter?: Record<string, unknown> | null;
  content: string;
}

interface FakeReaderState {
  notes: Map<string, FakeNote>;
  scanCalls: number;
  readPaths: string[];
}

function createReader(initial: Record<string, FakeNote>): {
  reader: VaultReader;
  state: FakeReaderState;
} {
  const state: FakeReaderState = {
    notes: new Map(Object.entries(initial)),
    scanCalls: 0,
    readPaths: [],
  };
  const reader: VaultReader = {
    async scan() {
      state.scanCalls += 1;
      return [...state.notes.keys()].sort();
    },
    async readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]> {
      state.readPaths.push(...input.paths);
      return input.paths.map((p) => {
        const note = state.notes.get(p);
        if (!note) {
          return {
            path: p,
            error: { code: 'NOT_FOUND', message: `Missing: ${p}` },
          } as ReadNotesItem;
        }
        return {
          path: p,
          frontmatter: note.frontmatter ?? null,
          content: note.content,
        };
      });
    },
  };
  return { reader, state };
}

describe('WikilinkGraphIndex', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('builds adjacency on first ensureFresh and serves both directions', async () => {
    const { reader } = createReader({
      'A.md': { content: 'Refers to [[B]] and [[C]].\n' },
      'B.md': { content: 'See [[C]].\n' },
      'C.md': { content: 'Leaf.\n' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    const a = graph.getNoteLinks('A.md');
    expect(a.outgoing).toEqual([
      { target: 'B', resolved: true, path: 'B.md' },
      { target: 'C', resolved: true, path: 'C.md' },
    ]);
    expect(a.incoming).toEqual([]);

    const c = graph.getNoteLinks('C.md');
    expect(c.incoming.map((e) => e.source).sort()).toEqual(['A.md', 'B.md']);
  });

  it('counts embeds (![[X]]) the same as plain wikilinks', async () => {
    const { reader } = createReader({
      'A.md': { content: '![[B]]\n' },
      'B.md': { content: 'leaf\n' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    expect(graph.getBacklinkCount('B.md')).toBe(1);
    expect(graph.getNoteLinks('A.md').outgoing).toEqual([
      { target: 'B', resolved: true, path: 'B.md' },
    ]);
  });

  it('keeps unresolved targets on outgoing with resolved:false', async () => {
    const { reader } = createReader({
      'A.md': { content: '[[Existing]] and [[Ghost concept]]\n' },
      'Existing.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    const a = graph.getNoteLinks('A.md');
    expect(a.outgoing).toEqual([
      { target: 'Existing', resolved: true, path: 'Existing.md' },
      { target: 'Ghost concept', resolved: false },
    ]);
  });

  it('drops self-links and dedupes repeated targets', async () => {
    const { reader } = createReader({
      'A.md': { content: '[[A]] [[B]] [[B]] [[Ghost]] [[Ghost]]\n' },
      'B.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    expect(graph.getNoteLinks('A.md').outgoing).toEqual([
      { target: 'B', resolved: true, path: 'B.md' },
      { target: 'Ghost', resolved: false },
    ]);
  });

  it('extracts wikilinks from frontmatter values too', async () => {
    const { reader } = createReader({
      'A.md': {
        frontmatter: { related: ['[[B]]', '[[C]]'] },
        content: 'no body links\n',
      },
      'B.md': { content: '' },
      'C.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    const targets = graph
      .getNoteLinks('A.md')
      .outgoing.map((e) => e.path)
      .sort();
    expect(targets).toEqual(['B.md', 'C.md']);
  });

  it('does not rebuild within the TTL window', async () => {
    const { reader, state } = createReader({
      'A.md': { content: '[[B]]\n' },
      'B.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({
      reader,
      now: clock,
      ttlMs: 1000,
    });

    await graph.ensureFresh();
    now += 500;
    await graph.ensureFresh();

    expect(state.scanCalls).toBe(1);
  });

  it('rebuilds once the TTL has elapsed', async () => {
    const { reader, state } = createReader({
      'A.md': { content: '[[B]]\n' },
      'B.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({
      reader,
      now: clock,
      ttlMs: 1000,
    });

    await graph.ensureFresh();
    now += 1500;
    await graph.ensureFresh();

    expect(state.scanCalls).toBe(2);
  });

  it('reflects a deleted note after the rebuild window', async () => {
    const { reader, state } = createReader({
      'A.md': { content: '[[B]]\n' },
      'B.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({
      reader,
      now: clock,
      ttlMs: 1000,
    });

    await graph.ensureFresh();
    expect(graph.getBacklinkCount('B.md')).toBe(1);

    state.notes.delete('A.md');
    now += 1500;
    await graph.ensureFresh();

    expect(graph.getBacklinkCount('B.md')).toBe(0);
    expect(graph.getNoteLinks('A.md')).toEqual({ incoming: [], outgoing: [] });
  });

  it('shares one in-flight build across concurrent ensureFresh calls', async () => {
    const scan = vi.fn(async () => ['A.md', 'B.md']);
    const readNotes = vi.fn(async (input: ReadNotesInput) =>
      input.paths.map((p) => ({
        path: p,
        frontmatter: null,
        content: p === 'A.md' ? '[[B]]\n' : '',
      })),
    );
    const reader: VaultReader = { scan, readNotes };
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await Promise.all([graph.ensureFresh(), graph.ensureFresh(), graph.ensureFresh()]);

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('returns empty adjacency for an unknown path', async () => {
    const { reader } = createReader({
      'A.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    expect(graph.getNoteLinks('Missing.md')).toEqual({ incoming: [], outgoing: [] });
    expect(graph.getBacklinkCount('Missing.md')).toBe(0);
  });

  it('returns defensive copies so mutating the result does not corrupt the index', async () => {
    const { reader } = createReader({
      'A.md': { content: '[[B]]\n' },
      'B.md': { content: '' },
    });
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    const first = graph.getNoteLinks('A.md');
    first.outgoing[0].path = 'tampered.md';

    const second = graph.getNoteLinks('A.md');
    expect(second.outgoing[0].path).toBe('B.md');
  });

  it('skips read errors without aborting the whole build', async () => {
    const reader: VaultReader = {
      async scan() {
        return ['A.md', 'B.md'];
      },
      async readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]> {
        return input.paths.map((p) => {
          if (p === 'A.md') {
            return {
              path: p,
              error: { code: 'READ_FAILED', message: 'boom' },
            } as ReadNotesItem;
          }
          return { path: p, frontmatter: null, content: '[[A]]\n' };
        });
      },
    };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const graph = new WikilinkGraphIndex({ reader, now: clock });

    await graph.ensureFresh();

    expect(graph.getNoteLinks('B.md').outgoing).toEqual([
      { target: 'A', resolved: true, path: 'A.md' },
    ]);
    expect(graph.getBacklinkCount('A.md')).toBe(1);
    stderrSpy.mockRestore();
  });
});
