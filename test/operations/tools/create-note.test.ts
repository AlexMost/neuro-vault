import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

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

  it('resolves template in-process and passes content (not template) to provider', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'nv-create-note-tpl-'));
    try {
      await mkdir(join(vaultRoot, 'Templates'), { recursive: true });
      await writeFile(join(vaultRoot, 'Templates', 'idea.md'), 'some content', 'utf8');

      const provider = makeProvider({
        createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
      });
      const registry = makeTestRegistry([{ name: 'v', path: vaultRoot, provider }]);
      const tool = buildCreateNoteTool({ registry });

      await tool.handler({ path: 'Inbox/x.md', template: 'Templates/idea.md' });

      const call = (provider.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(call['content']).toBe('some content');
      expect(call['template']).toBeUndefined();
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
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

  describe('template rendering (in-process)', () => {
    let tmp: string;

    afterEach(async () => {
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it('Test A — renders template in-process: passes content (not template) to provider', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'nv-create-note-'));
      await mkdir(join(tmp, 'Templates'), { recursive: true });
      // Path-form template with {{title}} only — fully deterministic.
      await writeFile(join(tmp, 'Templates', 'daily.md'), '# {{title}}\nsome body', 'utf8');

      const provider = makeProvider({
        createNote: vi.fn().mockResolvedValue({ path: 'Inbox/Today.md' }),
      });
      const registry = makeTestRegistry([{ name: 'v', path: tmp, provider }]);
      const tool = buildCreateNoteTool({ registry });

      await tool.handler({ path: 'Inbox/Today.md', template: 'Templates/daily.md' });

      expect(provider.createNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '# Today\nsome body',
          // template must NOT be forwarded
        }),
      );
      const call = (provider.createNote as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(call['template']).toBeUndefined();
    });

    it('Test B — Templater syntax throws TEMPLATE_UNSUPPORTED, provider never called', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'nv-create-note-'));
      await mkdir(join(tmp, 'Templates'), { recursive: true });
      await writeFile(join(tmp, 'Templates', 'bad.md'), '<% tp.date.now() %>', 'utf8');

      const provider = makeProvider({
        createNote: vi.fn().mockResolvedValue({ path: 'Inbox/x.md' }),
      });
      const registry = makeTestRegistry([{ name: 'v', path: tmp, provider }]);
      const tool = buildCreateNoteTool({ registry });

      await expect(
        tool.handler({ path: 'Inbox/x.md', template: 'Templates/bad.md' }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_UNSUPPORTED' });

      expect(provider.createNote).not.toHaveBeenCalled();
    });
  });
});
