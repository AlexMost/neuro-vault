import { describe, expect, it, vi } from 'vitest';

import { FsVaultProvider } from '../../src/modules/operations/fs-vault-provider.js';

describe('FsVaultProvider delegation', () => {
  it('delegates createNote to the internal CLI provider (same exec seam)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new FsVaultProvider({ exec });

    const result = await provider.createNote({ name: 'Idea 42', content: 'first thought' });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['create', 'name=Idea 42', 'content=first thought'],
      { timeout: 10_000 },
    );
    expect(result).toEqual({ path: 'Idea 42' });
  });

  it('delegates readDaily to daily:path + daily:read', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Daily/2026-07-16.md\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '---\nmood: ok\n---\n# Today\n', stderr: '' });
    const provider = new FsVaultProvider({ exec });

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: 'Daily/2026-07-16.md',
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
  });

  it('delegates setProperty, removeProperty, listTags, listProperties', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const provider = new FsVaultProvider({ vaultName: 'V', exec });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
      value: 'done',
    });
    await provider.removeProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
    });
    await provider.listTags();
    await provider.listProperties();

    expect(exec).toHaveBeenNthCalledWith(
      1,
      'obsidian',
      ['vault=V', 'property:set', 'name=status', 'value=done', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'obsidian',
      ['vault=V', 'property:remove', 'name=status', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      'obsidian',
      ['vault=V', 'tags', 'counts', 'sort=count', 'format=json'],
      {
        timeout: 10_000,
      },
    );
    expect(exec).toHaveBeenNthCalledWith(
      4,
      'obsidian',
      ['vault=V', 'properties', 'counts', 'sort=count', 'format=json'],
      { timeout: 10_000 },
    );
  });

  it('propagates CLI errors unchanged', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ENOENT' }));
    const provider = new FsVaultProvider({ exec });

    await expect(provider.listTags()).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });
});
