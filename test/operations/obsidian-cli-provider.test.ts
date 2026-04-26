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
    const exec = vi.fn().mockRejectedValue(
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

describe('ObsidianCLIProvider.setProperty', () => {
  it('builds property:set with explicit type and path target', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'Tasks/x.md' },
      name: 'status',
      value: 'done',
      type: 'text',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['property:set', 'name=status', 'value=done', 'type=text', 'path=Tasks/x.md'],
      { timeout: 10_000 },
    );
  });

  it('uses file= token when identifier kind is name', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.setProperty({
      identifier: { kind: 'name', value: 'My Note' },
      name: 'priority',
      value: '3',
      type: 'number',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['property:set', 'name=priority', 'value=3', 'type=number', 'file=My Note'],
      { timeout: 10_000 },
    );
  });

  it('omits type token when type is undefined', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'tag',
      value: 'x',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['property:set', 'name=tag', 'value=x', 'path=a.md'],
      { timeout: 10_000 },
    );
  });

  it('appends vault token when vaultName is set', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'Brain' });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'k',
      value: 'v',
      type: 'text',
    });

    const args = exec.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe('vault=Brain');
  });
});

describe('ObsidianCLIProvider.readProperty', () => {
  it('builds property:read args with name and path', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'done', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readProperty({
      identifier: { kind: 'path', value: 'Tasks/x.md' },
      name: 'status',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['property:read', 'name=status', 'path=Tasks/x.md'],
      { timeout: 10_000 },
    );
    expect(result).toEqual({ value: 'done' });
  });

  it('parses "true"/"false" stdout as boolean', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'true\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    const result = await provider.readProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'done',
    });
    expect(result).toEqual({ value: true });
  });

  it('parses numeric-only stdout as number', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '42\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    const result = await provider.readProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'priority',
    });
    expect(result).toEqual({ value: 42 });
  });

  it('parses multi-line stdout as list of trimmed strings', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'one\ntwo\n three\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    const result = await provider.readProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'tags',
    });
    expect(result).toEqual({ value: ['one', 'two', 'three'] });
  });

  it('returns string value for plain non-numeric, non-boolean output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'hello world\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    const result = await provider.readProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'note',
    });
    expect(result).toEqual({ value: 'hello world' });
  });

  it('throws PROPERTY_NOT_FOUND when stderr signals missing property', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'property not found: foo',
    });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(
      provider.readProperty({
        identifier: { kind: 'path', value: 'a.md' },
        name: 'foo',
      }),
    ).rejects.toBeInstanceOf(ToolHandlerError);
    await expect(
      provider.readProperty({
        identifier: { kind: 'path', value: 'a.md' },
        name: 'foo',
      }),
    ).rejects.toMatchObject({ code: 'PROPERTY_NOT_FOUND' });
  });
});

describe('ObsidianCLIProvider.listProperties', () => {
  it('builds args with counts, sort=count, format=json', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '[{"name":"status","count":12},{"name":"tags","count":7}]',
      stderr: '',
    });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.listProperties();

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['properties', 'counts', 'sort=count', 'format=json'],
      { timeout: 10_000 },
    );
    expect(result).toEqual([
      { name: 'status', count: 12 },
      { name: 'tags', count: 7 },
    ]);
  });

  it('returns empty array when CLI emits []', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    expect(await provider.listProperties()).toEqual([]);
  });

  it('throws CLI_ERROR on garbled JSON', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(provider.listProperties()).rejects.toMatchObject({ code: 'CLI_ERROR' });
  });

  it('throws CLI_ERROR when CLI emits valid JSON that is not an array', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"error":"unexpected"}', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(provider.listProperties()).rejects.toMatchObject({
      code: 'CLI_ERROR',
      message: expect.stringContaining('expected array'),
    });
  });
});

describe('ObsidianCLIProvider.removeProperty', () => {
  it('builds property:remove args', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.removeProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['property:remove', 'name=status', 'path=a.md'],
      { timeout: 10_000 },
    );
  });

  it('is idempotent — swallows "property not found" stderr', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'property not found: status',
    });
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.removeProperty({
        identifier: { kind: 'path', value: 'a.md' },
        name: 'status',
      }),
    ).resolves.toBeUndefined();
  });

  it('still throws NOT_FOUND when the file itself is missing', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'file not found: a.md',
    });
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.removeProperty({
        identifier: { kind: 'path', value: 'a.md' },
        name: 'status',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ObsidianCLIProvider.listTags', () => {
  it('builds args with counts, sort=count, format=json', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '[{"name":"mcp","count":5},{"name":"obsidian","count":3}]',
      stderr: '',
    });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.listTags();

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['tags', 'counts', 'sort=count', 'format=json'],
      { timeout: 10_000 },
    );
    expect(result).toEqual([
      { name: 'mcp', count: 5 },
      { name: 'obsidian', count: 3 },
    ]);
  });

  it('returns empty array on []', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    expect(await provider.listTags()).toEqual([]);
  });

  it('throws CLI_ERROR on garbled JSON', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'oops', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(provider.listTags()).rejects.toMatchObject({ code: 'CLI_ERROR' });
  });
});

describe('ObsidianCLIProvider.getTag', () => {
  it('uses verbose flag when includeFiles is true', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '3\nFolder/a.md\nFolder/b.md\nFolder/c.md',
      stderr: '',
    });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.getTag({ name: 'mcp', includeFiles: true });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['tag', 'name=mcp', 'verbose'],
      { timeout: 10_000 },
    );
    expect(result).toEqual({
      name: 'mcp',
      count: 3,
      files: ['Folder/a.md', 'Folder/b.md', 'Folder/c.md'],
    });
  });

  it('uses total flag when includeFiles is false', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '7\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.getTag({ name: 'obsidian', includeFiles: false });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['tag', 'name=obsidian', 'total'],
      { timeout: 10_000 },
    );
    expect(result).toEqual({ name: 'obsidian', count: 7 });
  });

  it('throws TAG_NOT_FOUND when stderr says tag not found', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'tag not found: nonsense',
    });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(
      provider.getTag({ name: 'nonsense', includeFiles: true }),
    ).rejects.toMatchObject({ code: 'TAG_NOT_FOUND' });
  });

  it('throws TAG_NOT_FOUND when total returns 0', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '0\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(
      provider.getTag({ name: 'nonsense', includeFiles: false }),
    ).rejects.toMatchObject({ code: 'TAG_NOT_FOUND' });
  });

  it('throws CLI_ERROR when verbose output starts with non-numeric line', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'Files using #mcp:\nFolder/a.md',
      stderr: '',
    });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(
      provider.getTag({ name: 'mcp', includeFiles: true }),
    ).rejects.toMatchObject({ code: 'CLI_ERROR' });
  });

  it('throws CLI_ERROR when total output is non-numeric', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'oops\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    await expect(
      provider.getTag({ name: 'mcp', includeFiles: false }),
    ).rejects.toMatchObject({ code: 'CLI_ERROR' });
  });
});
