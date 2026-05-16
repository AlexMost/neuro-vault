import { describe, expect, it, vi } from 'vitest';

import { buildRemovePropertyTool } from '../../../src/modules/operations/tools/remove-property.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.removeProperty handler', () => {
  it('returns { vault, ok: true } on success', async () => {
    const provider = makeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildRemovePropertyTool({ registry });

    const result = await tool.handler({ path: 'a.md', key: 'status' });

    expect(provider.removeProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ vault: 'v', ok: true });
  });

  it('returns { vault, ok: true } even when provider already swallowed PROPERTY_NOT_FOUND', async () => {
    const provider = makeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildRemovePropertyTool({ registry });
    expect(await tool.handler({ path: 'a.md', key: 'gone' })).toEqual({ vault: 'v', ok: true });
  });

  it('rejects empty name with INVALID_ARGUMENT', async () => {
    const registry = makeTestRegistry([{ name: 'v', provider: makeProvider() }]);
    const tool = buildRemovePropertyTool({ registry });
    await expect(tool.handler({ path: 'a.md', key: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildRemovePropertyTool({ registry });
    await expect(tool.handler({ path: '../escape.md', key: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildRemovePropertyTool({ registry });
    await expect(tool.handler({ path: '/etc/passwd', key: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });
});
