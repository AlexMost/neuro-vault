import { describe, expect, it, vi } from 'vitest';

import { GraphReadError, type IGraphReader } from '../../src/lib/obsidian/graph-reader.js';
import { graphForTool } from '../../src/lib/tool-graph.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { makeVaultGraph } from '../_vault-graph.js';

type Read = keyof IGraphReader;

const READS: Array<{ read: Read; call: (g: IGraphReader) => Promise<unknown> }> = [
  { read: 'noteLinks', call: (g) => g.noteLinks('a.md') },
  { read: 'backlinkCounts', call: (g) => g.backlinkCounts(['a.md']) },
  { read: 'resolve', call: (g) => g.resolve(['a']) },
];

function failing(read: Read, error: unknown): IGraphReader {
  return makeVaultGraph({
    [read]: vi.fn(async () => {
      throw error;
    }),
  });
}

describe('graphForTool', () => {
  it('delegates every read and answers as the entry graph does', async () => {
    const graph = makeVaultGraph({
      noteLinks: vi.fn(async () => ({ incoming: [{ source: 'b.md' }], outgoing: [] })),
      backlinkCounts: vi.fn(async (paths: readonly string[]) => paths.map(() => 3)),
      resolve: vi.fn(async (targets: readonly string[]) => targets.map(() => 'a.md')),
    });
    const mapped = graphForTool({ name: 'v', graph }, 'op', vi.fn());

    expect(await mapped.noteLinks('a.md')).toEqual({
      incoming: [{ source: 'b.md' }],
      outgoing: [],
    });
    expect(await mapped.backlinkCounts(['a.md', 'b.md'])).toEqual([3, 3]);
    expect(await mapped.resolve(['a'])).toEqual(['a.md']);
    expect(graph.noteLinks).toHaveBeenCalledExactlyOnceWith('a.md');
    expect(graph.backlinkCounts).toHaveBeenCalledExactlyOnceWith(['a.md', 'b.md']);
    expect(graph.resolve).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it.each(READS)('maps a GraphReadError from $read to DEPENDENCY_ERROR', async ({ read, call }) => {
    const cause = new GraphReadError('daemon did not answer graph.x in time');
    const warn = vi.fn();
    const mapped = graphForTool({ name: 'v', graph: failing(read, cause) }, 'op', warn);

    const error = await call(mapped).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolHandlerError);
    expect(error).toMatchObject({
      code: 'DEPENDENCY_ERROR',
      message: 'Graph read failed',
      details: { vault: 'v', operation: 'op' },
      cause,
    });
    expect((error as ToolHandlerError).details).toEqual({ vault: 'v', operation: 'op' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'neuro-vault graph: op failed for vault "v": daemon did not answer graph.x in time',
    );
  });

  it.each(READS)('rethrows any other error from $read as itself', async ({ read, call }) => {
    const bug = new TypeError('boom');
    const warn = vi.fn();
    const mapped = graphForTool({ name: 'v', graph: failing(read, bug) }, 'op', warn);

    await expect(call(mapped)).rejects.toBe(bug);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes to console.error when no warn is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mapped = graphForTool(
        { name: 'v', graph: failing('resolve', new GraphReadError('lost')) },
        'op',
      );
      await expect(mapped.resolve(['a'])).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
      expect(spy).toHaveBeenCalledExactlyOnceWith(
        'neuro-vault graph: op failed for vault "v": lost',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
