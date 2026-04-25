import { describe, expect, it, vi } from 'vitest';

import { ObsidianCLIProvider } from '../../src/modules/operations/obsidian-cli-provider.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';

describe('ObsidianCLIProvider.readNote', () => {
  it('parses path and content from "<path>\\n---\\n<body>" stdout', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'Folder/note.md\n---\n# Hello\nbody\n',
      stderr: '',
    });

    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readNote({
      identifier: { kind: 'name', value: 'My Note' },
    });

    expect(exec).toHaveBeenCalledWith('obsidian', ['read', 'file=My Note'], { timeout: 10_000 });
    expect(result).toEqual({ path: 'Folder/note.md', content: '# Hello\nbody\n' });
  });

  it('falls back to whole stdout as content when separator is missing', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'just a body without sep', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readNote({
      identifier: { kind: 'path', value: 'Folder/note.md' },
    });

    expect(result).toEqual({ path: '', content: 'just a body without sep' });
  });

  it('builds path= token when identifier is a path', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'Folder/note.md\n---\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.readNote({ identifier: { kind: 'path', value: 'Folder/note.md' } });

    expect(exec).toHaveBeenCalledWith('obsidian', ['read', 'path=Folder/note.md'], {
      timeout: 10_000,
    });
  });

  it('appends vault=<name> to args when vaultName is set', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'Folder/x.md\n---\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'Brain' });

    await provider.readNote({ identifier: { kind: 'path', value: 'Folder/x.md' } });

    expect(exec).toHaveBeenCalledWith('obsidian', ['read', 'path=Folder/x.md', 'vault=Brain'], {
      timeout: 10_000,
    });
  });
});

describe('ObsidianCLIProvider.createNote', () => {
  it('passes name, content, and template tokens', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.createNote({
      name: 'Idea 42',
      content: 'first thought',
      template: 'idea',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['create', 'name=Idea 42', 'content=first thought', 'template=idea'],
      { timeout: 10_000 },
    );
  });

  it('appends overwrite token when overwrite is true', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.createNote({ path: 'Inbox/x.md', overwrite: true });

    expect(exec).toHaveBeenCalledWith('obsidian', ['create', 'path=Inbox/x.md', 'overwrite'], {
      timeout: 10_000,
    });
  });

  it('returns the path passed in (path identifier)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.createNote({ path: 'Inbox/x.md' });

    expect(result).toEqual({ path: 'Inbox/x.md' });
  });
});

describe('ObsidianCLIProvider.editNote', () => {
  it('uses append command for position=append', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.editNote({
      identifier: { kind: 'name', value: 'Notes' },
      content: 'new line',
      position: 'append',
    });

    expect(exec).toHaveBeenCalledWith('obsidian', ['append', 'file=Notes', 'content=new line'], {
      timeout: 10_000,
    });
  });

  it('uses prepend command for position=prepend with path identifier', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.editNote({
      identifier: { kind: 'path', value: 'Daily/foo.md' },
      content: 'first',
      position: 'prepend',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['prepend', 'path=Daily/foo.md', 'content=first'],
      { timeout: 10_000 },
    );
  });
});

describe('ObsidianCLIProvider daily', () => {
  it('readDaily parses path and content from daily:read output', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'Daily/2026-04-25.md\n---\n# Today\n',
      stderr: '',
    });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readDaily();

    expect(exec).toHaveBeenCalledWith('obsidian', ['daily:read'], { timeout: 10_000 });
    expect(result).toEqual({ path: 'Daily/2026-04-25.md', content: '# Today\n' });
  });

  it('appendDaily passes content token', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.appendDaily({ content: '- new task' });

    expect(exec).toHaveBeenCalledWith('obsidian', ['daily:append', 'content=- new task'], {
      timeout: 10_000,
    });
  });
});

describe('ObsidianCLIProvider error mapping', () => {
  it('maps spawn ENOENT to CLI_NOT_FOUND', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.readNote({ identifier: { kind: 'name', value: 'foo' } }),
    ).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });

  it('maps stderr "Obsidian is not running" to CLI_UNAVAILABLE', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 1'), {
          code: 1,
          stdout: '',
          stderr: 'Obsidian is not running',
        }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.readNote({ identifier: { kind: 'name', value: 'foo' } }),
    ).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' });
  });

  it('maps stderr "already exists" on create to NOTE_EXISTS', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'File already exists' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(provider.createNote({ path: 'Inbox/x.md' })).rejects.toMatchObject({
      code: 'NOTE_EXISTS',
    });
  });

  it('maps stderr "not found" on read to NOT_FOUND', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'File not found' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.readNote({ identifier: { kind: 'path', value: 'missing.md' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps timeout error (code ETIMEDOUT) to CLI_TIMEOUT', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.readNote({ identifier: { kind: 'name', value: 'x' } }),
    ).rejects.toMatchObject({ code: 'CLI_TIMEOUT' });
  });

  it('maps anything else to CLI_ERROR with stderr in details', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 2'), { code: 2, stdout: '', stderr: 'weird thing happened' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(provider.readNote({ identifier: { kind: 'name', value: 'x' } })).rejects.toSatisfy(
      (err: ToolHandlerError) => {
        return err.code === 'CLI_ERROR' && err.details?.stderr === 'weird thing happened';
      },
    );
  });
});
