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
});
