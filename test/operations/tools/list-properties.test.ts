import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.listProperties handler', () => {
  it('forwards to provider and wraps result with vault', async () => {
    const provider = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 5 }]),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildListPropertiesTool({ registry });
    expect(await tool.handler({})).toEqual({
      vault: 'v',
      results: [{ name: 'status', count: 5 }],
    });
    expect(provider.listProperties).toHaveBeenCalled();
  });
});
