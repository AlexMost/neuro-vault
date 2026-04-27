import { describe, expect, it, vi } from 'vitest';

import { buildRemovePropertyTool } from '../../../src/modules/operations/tools/remove-property.js';
import { makeProvider } from './_helpers.js';

describe('operations.removeProperty handler', () => {
  it('returns { ok: true } on success', async () => {
    const provider = makeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const tool = buildRemovePropertyTool({ provider });

    const result = await tool.handler({ path: 'a.md', key: 'status' });

    expect(provider.removeProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: true } even when provider already swallowed PROPERTY_NOT_FOUND', async () => {
    const provider = makeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const tool = buildRemovePropertyTool({ provider });
    expect(await tool.handler({ path: 'a.md', key: 'gone' })).toEqual({ ok: true });
  });

  it('rejects empty name with INVALID_ARGUMENT', async () => {
    const tool = buildRemovePropertyTool({ provider: makeProvider() });
    await expect(tool.handler({ path: 'a.md', key: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    const tool = buildRemovePropertyTool({ provider });
    await expect(tool.handler({ path: '../escape.md', key: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = makeProvider();
    const tool = buildRemovePropertyTool({ provider });
    await expect(tool.handler({ path: '/etc/passwd', key: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });
});
