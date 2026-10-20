import { describe, expect, it, vi } from 'vitest';

import { buildGetNoteLinksTool } from '../../../src/modules/operations/tools/get-note-links.js';
import type { IGraphReader } from '../../../src/lib/obsidian/graph-reader.js';
import type { NoteLinks } from '../../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool, expectToolError } from '../../_gate.js';
import { failingGraph, makeVaultGraph } from '../../_vault-graph.js';
import { makeTestRegistry } from './_test-registry.js';

function makeLinksGraph(linksFor: Record<string, NoteLinks>): IGraphReader {
  return makeVaultGraph({
    noteLinks: vi.fn(async (path: string) => linksFor[path] ?? { incoming: [], outgoing: [] }),
  });
}

describe('get_note_links tool', () => {
  it('returns the adjacency for the requested path (with vault field)', async () => {
    const graph = makeLinksGraph({
      'Folder/A.md': {
        incoming: [{ source: 'Folder/B.md' }],
        outgoing: [
          { target: 'C', resolved: true, path: 'Folder/C.md' },
          { target: 'Ghost', resolved: false },
        ],
      },
    });
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    const out = await callTool(registerTool(buildGetNoteLinksTool({ registry })), {
      path: 'Folder/A.md',
    });

    expect(out).toEqual({
      vault: 'v',
      incoming: [{ source: 'Folder/B.md' }],
      outgoing: [
        { target: 'C', resolved: true, path: 'Folder/C.md' },
        { target: 'Ghost', resolved: false },
      ],
    });
    expect(graph.noteLinks).toHaveBeenCalledExactlyOnceWith('Folder/A.md');
  });

  it('makes one graph read and no other', async () => {
    const graph = makeVaultGraph();
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    await callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'X.md' });

    expect(graph.noteLinks).toHaveBeenCalledExactlyOnceWith('X.md');
    expect(graph.backlinkCounts).not.toHaveBeenCalled();
    expect(graph.resolve).not.toHaveBeenCalled();
  });

  it('normalizes the input path before querying the graph', async () => {
    const graph = makeLinksGraph({});
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    await callTool(registerTool(buildGetNoteLinksTool({ registry })), {
      path: '  Folder/A.md  ',
    });

    expect(graph.noteLinks).toHaveBeenCalledWith('Folder/A.md');
  });

  it('auto-appends .md to a path without an extension', async () => {
    const graph = makeLinksGraph({
      'Folder/A.md': {
        incoming: [{ source: 'Folder/B.md' }],
        outgoing: [],
      },
    });
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    await callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'Folder/A' });

    expect(graph.noteLinks).toHaveBeenCalledWith('Folder/A.md');
  });

  it('returns an empty adjacency for an unknown path', async () => {
    const graph = makeLinksGraph({});
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    expect(
      await callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'Missing.md' }),
    ).toEqual({
      vault: 'v',
      incoming: [],
      outgoing: [],
    });
  });

  it('exposes its name and description', () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeVaultGraph() }]);
    const tool = buildGetNoteLinksTool({ registry });

    expect(tool.name).toBe('get_note_links');
    expect(tool.description).toMatch(/incoming/i);
    expect(tool.description).toMatch(/outgoing/i);
    expect(tool.description).toMatch(/resolved/i);
  });

  it('rejects an empty path at the gate', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeVaultGraph() }]);

    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: '' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'path' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeVaultGraph() }]);

    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'A.md', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('a failed graph read is DEPENDENCY_ERROR, with the cause on stderr only', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const registry = makeTestRegistry([
        { name: 'v', graph: failingGraph('noteLinks', 'daemon connection lost') },
      ]);

      const error = await expectToolError(registerTool(buildGetNoteLinksTool({ registry })), {
        path: 'A.md',
      });

      expect(error).toEqual({
        code: 'DEPENDENCY_ERROR',
        message: 'Graph read failed',
        details: { vault: 'v', operation: 'get_note_links' },
      });
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        'neuro-vault graph: get_note_links failed for vault "v": daemon connection lost',
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
