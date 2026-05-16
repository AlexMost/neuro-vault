import { describe, expect, it, vi } from 'vitest';

import { buildCreateNoteTool } from '../../../src/modules/operations/tools/create-note.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.createNote handler', () => {
  it('forwards normalized fields to provider.createNote and includes vault', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/idea.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    const result = await tool.handler({
      path: 'Inbox/idea.md',
      content: 'hello',
      overwrite: true,
    });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/idea.md',
      content: 'hello',
      overwrite: true,
    });
    expect(result).toEqual({ vault: 'v', path: 'Inbox/idea.md' });
  });

  it('rejects when neither name nor path is provided', async () => {
    const registry = makeTestRegistry([{ name: 'v', provider: makeProvider() }]);
    const tool = buildCreateNoteTool({ registry });
    await expect(tool.handler({ content: 'hello' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });
    await expect(tool.handler({ path: '../../etc/passwd', content: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('rejects Unix absolute path', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });
    await expect(tool.handler({ path: '/tmp/escape.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('rejects Windows absolute path', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });
    await expect(tool.handler({ path: 'C:\\Users\\me\\note.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('normalizes path before forwarding', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({ path: './Inbox/x.md' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Inbox/x.md' }),
    );
  });

  it('rejects when both content and template are provided', async () => {
    const provider = makeProvider();
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await expect(
      tool.handler({ path: 'Inbox/x.md', content: 'hello', template: 'idea' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { field: 'content' },
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('forwards content alone to provider', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({ path: 'Inbox/x.md', content: 'hello' });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: 'hello',
    });
  });

  it('forwards template alone to provider', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({ path: 'Inbox/x.md', template: 'idea' });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      template: 'idea',
    });
  });

  it('throws VAULT_REQUIRED in multi-vault mode when vault is omitted', async () => {
    const registry = makeTestRegistry([
      { name: 'a', provider: makeProvider() },
      { name: 'b', provider: makeProvider() },
    ]);
    const tool = buildCreateNoteTool({ registry });

    await expect(tool.handler({ path: 'Inbox/x.md', content: 'hello' })).rejects.toMatchObject({
      code: 'VAULT_REQUIRED',
      details: {
        tool: 'create_note',
        registered_vaults: ['a', 'b'],
      },
    });
  });

  it('routes to the named vault in multi-vault mode when vault is provided', async () => {
    const providerA = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'A/x.md' }),
    });
    const providerB = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'B/x.md' }),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildCreateNoteTool({ registry });

    const result = await tool.handler({ vault: 'b', path: 'B/x.md', content: 'hi' });

    expect(providerA.createNote).not.toHaveBeenCalled();
    expect(providerB.createNote).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ vault: 'b', path: 'B/x.md' });
  });

  it('throws VAULT_NOT_FOUND when vault is provided but unknown', async () => {
    const registry = makeTestRegistry([{ name: 'a', provider: makeProvider() }]);
    const tool = buildCreateNoteTool({ registry });

    await expect(
      tool.handler({ vault: 'ghost', path: 'x.md', content: 'hi' }),
    ).rejects.toMatchObject({
      code: 'VAULT_NOT_FOUND',
    });
  });
});
