import { describe, expect, it, vi } from 'vitest';

import { buildListTagsTool } from '../../../src/modules/operations/tools/list-tags.js';
import { makeProvider } from './_helpers.js';

describe('operations.listTags handler', () => {
  it('forwards to provider', async () => {
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 3 }]),
    });
    const tool = buildListTagsTool({ provider });
    expect(await tool.handler({})).toEqual([{ name: 'mcp', count: 3 }]);
    expect(provider.listTags).toHaveBeenCalled();
  });
});
