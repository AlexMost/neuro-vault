import { describe, expect, it, vi } from 'vitest';

import { buildCreateNoteTool } from '../../../src/modules/operations/tools/create-note.js';
import { splitFrontmatter } from '../../../src/lib/obsidian/frontmatter.js';
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

  it('auto-appends .md to a path without an extension', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/Foo.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({ path: 'Inbox/Foo' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Inbox/Foo.md' }),
    );
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

  it('serializes frontmatter and prepends it to the content body', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({
      path: 'Inbox/x.md',
      frontmatter: { type: 'task', tags: ['mcp'] },
      content: '# Title\nBody\n',
    });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: '---\ntype: task\ntags:\n  - mcp\n---\n# Title\nBody\n',
    });
  });

  it('round-trips: provider content splits back to the input frontmatter and body', async () => {
    let captured = '';
    const provider = makeProvider({
      createNote: vi.fn().mockImplementation((arg: { content?: string }) => {
        captured = arg.content ?? '';
        return Promise.resolve({ path: 'Inbox/x.md' });
      }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    const fm = { type: 'task', project: '[[neuro-vault]]', tags: ['mcp', 'dx'] };
    await tool.handler({ path: 'Inbox/x.md', frontmatter: fm, content: 'Body only\n' });

    const { frontmatter, content } = splitFrontmatter(captured);
    expect(frontmatter).toEqual(fm);
    expect(content).toBe('Body only\n');
  });

  it('merges content frontmatter with the param, param winning on key collision', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({
      path: 'Inbox/x.md',
      frontmatter: { type: 'task' },
      content: '---\ntype: idea\nstale: true\n---\n# Title\n',
    });

    // `type` collides → param wins (task); `stale` is content-only → survives.
    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: '---\ntype: task\nstale: true\n---\n# Title\n',
    });
  });

  it('merge keeps content-only keys and adds param-only keys', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({
      path: 'Inbox/x.md',
      frontmatter: { type: 'task', tags: ['mcp'] },
      content: '---\ncreated: 2026-06-01\ntype: idea\n---\nBody\n',
    });

    // created survives (content-only); type collides → param wins; tags added (param-only).
    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: '---\ncreated: 2026-06-01\ntype: task\ntags:\n  - mcp\n---\nBody\n',
    });
  });

  it('treats an empty frontmatter object as absent (verbatim content passthrough)', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({
      path: 'Inbox/x.md',
      frontmatter: {},
      content: '---\ntype: idea\n---\nBody\n',
    });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: '---\ntype: idea\n---\nBody\n',
    });
  });

  it('serializes frontmatter with no content into a block with an empty body', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildCreateNoteTool({ registry });

    await tool.handler({ path: 'Inbox/x.md', frontmatter: { type: 'task' } });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/x.md',
      content: '---\ntype: task\n---\n',
    });
  });
});
