import { describe, expect, it, vi } from 'vitest';

import { buildListTagsTool } from '../../../src/modules/operations/tools/list-tags.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.listTags handler', () => {
  it('forwards to provider and wraps result with vault', async () => {
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 3 }]),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildListTagsTool({ registry });
    expect(await tool.handler({})).toEqual({
      vault: 'v',
      results: [{ name: 'mcp', count: 3 }],
    });
    expect(provider.listTags).toHaveBeenCalled();
  });
});
