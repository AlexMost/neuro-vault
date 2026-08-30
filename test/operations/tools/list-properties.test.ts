import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildReg(names: string[] = ['v']) {
  const registry = makeTestRegistry(
    names.map((name) => ({
      name,
      provider: makeProvider({
        listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 2 }]),
      }),
    })),
  );
  return registerTool(buildListPropertiesTool({ registry }));
}

describe('list_properties through the registration gate', () => {
  it('returns the vault-scoped property list', async () => {
    expect(await callTool(buildReg(), {})).toEqual({
      vault: 'v',
      results: [{ name: 'status', count: 2 }],
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(buildReg(), { vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('accepts a vault argument in multi-vault mode', async () => {
    const out = await callTool<{ vault: string }>(buildReg(['a', 'b']), { vault: 'b' });
    expect(out.vault).toBe('b');
  });

  it('rejects an unknown key', async () => {
    await expect(callTool(buildReg(), { prefix: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('prefix') }] },
    });
  });
});
