import { describe, expect, it, vi } from 'vitest';

import { buildRemovePropertyTool } from '../../../src/modules/operations/tools/remove-property.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildReg(provider: VaultProvider = makeProvider()) {
  return registerTool(
    buildRemovePropertyTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
  );
}

describe('operations.removeProperty handler', () => {
  it('returns { vault, ok: true } on success', async () => {
    const provider = makeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });

    const result = await callTool(buildReg(provider), { path: 'a.md', key: 'status' });

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

    expect(await callTool(buildReg(provider), { path: 'a.md', key: 'gone' })).toEqual({
      vault: 'v',
      ok: true,
    });
  });

  it('rejects empty name with INVALID_ARGUMENT', async () => {
    await expect(callTool(buildReg(), { path: 'a.md', key: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    await expect(
      callTool(buildReg(provider), { path: '../escape.md', key: 'x' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = makeProvider();
    await expect(
      callTool(buildReg(provider), { path: '/etc/passwd', key: 'x' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });

  it('rejects a missing key at the gate', async () => {
    await expect(callTool(buildReg(), { path: 'a.md' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'key' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(
      callTool(buildReg(), { path: 'a.md', key: 'k', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('rejects an unknown key', async () => {
    await expect(
      callTool(buildReg(), { path: 'a.md', key: 'k', value: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('value') }] },
    });
  });
});
