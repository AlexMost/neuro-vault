import { describe, expect, it, vi } from 'vitest';

import { buildGetNoteLinksTool } from '../../../src/modules/operations/tools/get-note-links.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { makeGraph } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function makeLinksGraph(
  linksFor: Record<string, ReturnType<WikilinkGraphIndex['getNoteLinks']>>,
): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn((path: string) => linksFor[path] ?? { incoming: [], outgoing: [] }),
    getBacklinkCount: vi.fn(),
  } as unknown as WikilinkGraphIndex;
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
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('calls ensureFresh before reading the adjacency', async () => {
    const order: string[] = [];
    const graph = {
      ensureFresh: vi.fn(async () => {
        order.push('ensureFresh');
      }),
      getNoteLinks: vi.fn(() => {
        order.push('getNoteLinks');
        return { incoming: [], outgoing: [] };
      }),
      getBacklinkCount: vi.fn(),
    } as unknown as WikilinkGraphIndex;
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    await callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'X.md' });

    expect(order).toEqual(['ensureFresh', 'getNoteLinks']);
  });

  it('normalizes the input path before querying the graph', async () => {
    const graph = makeLinksGraph({});
    const registry = makeTestRegistry([{ name: 'v', graph }]);

    await callTool(registerTool(buildGetNoteLinksTool({ registry })), {
      path: '  Folder/A.md  ',
    });

    expect(graph.getNoteLinks).toHaveBeenCalledWith('Folder/A.md');
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

    expect(graph.getNoteLinks).toHaveBeenCalledWith('Folder/A.md');
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
    const registry = makeTestRegistry([{ name: 'v', graph: makeGraph() }]);
    const tool = buildGetNoteLinksTool({ registry });

    expect(tool.name).toBe('get_note_links');
    expect(tool.description).toMatch(/incoming/i);
    expect(tool.description).toMatch(/outgoing/i);
    expect(tool.description).toMatch(/resolved/i);
  });

  it('rejects an empty path at the gate', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeGraph() }]);

    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: '' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'path' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeGraph() }]);

    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'A.md', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
});
