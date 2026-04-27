import { describe, expect, it, vi } from 'vitest';

import { buildReadPropertyTool } from '../../../src/modules/operations/tools/read-property.js';
import { makeProvider } from './_helpers.js';

describe('operations.readProperty handler', () => {
  it('forwards to provider with resolved path target', async () => {
    const provider = makeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 'done' }),
    });
    const tool = buildReadPropertyTool({ provider });

    const result = await tool.handler({ path: 'a.md', key: 'status' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ value: 'done' });
  });

  it('forwards name target via wikilink kind', async () => {
    const provider = makeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 42 }),
    });
    const tool = buildReadPropertyTool({ provider });

    await tool.handler({ name: 'My Note', key: 'priority' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'My Note' },
      name: 'priority',
    });
  });

  it('rejects when neither name nor path is provided', async () => {
    const tool = buildReadPropertyTool({ provider: makeProvider() });
    await expect(tool.handler({ key: 'x' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
