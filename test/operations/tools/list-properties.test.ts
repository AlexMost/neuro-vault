import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { makeProvider } from './_helpers.js';

describe('operations.listProperties handler', () => {
  it('forwards to provider', async () => {
    const provider = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 5 }]),
    });
    const tool = buildListPropertiesTool({ provider });
    expect(await tool.handler({})).toEqual([{ name: 'status', count: 5 }]);
    expect(provider.listProperties).toHaveBeenCalled();
  });
});
