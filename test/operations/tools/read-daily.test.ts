import { describe, expect, it, vi } from 'vitest';

import { buildReadDailyTool } from '../../../src/modules/operations/tools/read-daily.js';
import { makeProvider } from './_helpers.js';

describe('operations.readDaily handler', () => {
  it('forwards to provider.readDaily and returns the result', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-04-25.md', frontmatter: null, content: 'today' }),
    });
    const tool = buildReadDailyTool({ provider });

    const result = await tool.handler({});

    expect(provider.readDaily).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      path: 'Daily/2026-04-25.md',
      frontmatter: null,
      content: 'today',
    });
  });
});
