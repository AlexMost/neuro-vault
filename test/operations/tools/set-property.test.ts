import { describe, expect, it } from 'vitest';

import { buildSetPropertyTool } from '../../../src/modules/operations/tools/set-property.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildReg(provider: VaultProvider) {
  return registerTool(
    buildSetPropertyTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
  );
}

describe('operations.setProperty handler', () => {
  it('infers type=text for string value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
      value: 'done',
      type: 'text',
    });
  });

  it('infers type=number for number value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'priority', value: 3 });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, type: 'number' }),
    );
  });

  it('infers type=checkbox for boolean value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'done', value: true });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: true, type: 'checkbox' }),
    );
  });

  it('infers type=list for array value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'tags', value: ['mcp', 'todo'] });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['mcp', 'todo'], type: 'list' }),
    );
  });

  it('explicit type overrides inference', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), {
      path: 'a.md',
      key: 'due',
      value: '2026-05-01',
      type: 'date',
    });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01', type: 'date' }),
    );
  });

  it('rejects non-ISO date format with INVALID_ARGUMENT', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), { path: 'a.md', key: 'due', value: '03.05.2026', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects logically invalid date with INVALID_ARGUMENT', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), { path: 'a.md', key: 'due', value: '2026-13-45', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects non-string value when type=date', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), {
        path: 'a.md',
        key: 'due',
        value: 12345,
        type: 'date',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('accepts ISO datetime with explicit type=datetime', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), {
      path: 'a.md',
      key: 'startedAt',
      value: '2026-05-01T14:30:00Z',
      type: 'datetime',
    });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01T14:30:00Z', type: 'datetime' }),
    );
  });

  it('rejects space-separated datetime as non-ISO', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), {
        path: 'a.md',
        key: 'startedAt',
        value: '2026-05-01 14:30:00',
        type: 'datetime',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects array element containing comma', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), { path: 'a.md', key: 'tags', value: ['hello, world', 'ok'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  // `value` is a union of string/number/boolean/string[]/number[], so `null`
  // never survives the gate. The handler's UNSUPPORTED_VALUE_TYPE branch is
  // what used to answer here; through the registration it is INVALID_PARAMS at
  // `value`, which is what a real client sees.
  it('rejects a null value at the gate', async () => {
    const provider = makeProvider();

    await expect(
      callTool(buildReg(provider), { path: 'a.md', key: 'x', value: null }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'value' }] },
    });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects when neither name nor path is provided', async () => {
    await expect(
      callTool(buildReg(makeProvider()), { key: 'x', value: 'y' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when both name and path are provided', async () => {
    await expect(
      callTool(buildReg(makeProvider()), { name: 'a', path: 'b.md', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    await expect(
      callTool(buildReg(provider), { path: '../../etc/passwd', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = makeProvider();
    await expect(
      callTool(buildReg(provider), { path: '/tmp/x.md', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('parses a JSON-string array into the list branch of value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'tags', value: '["x","y"]' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['x', 'y'], type: 'list' }),
    );
  });

  it('leaves a plain string on the string branch of value', async () => {
    const provider = makeProvider();

    await callTool(buildReg(provider), { path: 'a.md', key: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'done', type: 'text' }),
    );
  });

  it('rejects an out-of-enum type at the gate', async () => {
    await expect(
      callTool(buildReg(makeProvider()), { path: 'a.md', key: 'k', value: 'v', type: 'timestamp' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'type' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(
      callTool(buildReg(makeProvider()), { path: 'a.md', key: 'k', value: 'v', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('rejects an unknown key', async () => {
    await expect(
      callTool(buildReg(makeProvider()), { path: 'a.md', key: 'k', value: 'v', overwrite: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('overwrite') }] },
    });
  });
});
