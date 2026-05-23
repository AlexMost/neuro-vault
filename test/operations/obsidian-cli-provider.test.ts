import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ObsidianCLIProvider } from '../../src/modules/operations/obsidian-cli-provider.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';

describe('ObsidianCLIProvider.createNote', () => {
  it('passes name and content tokens', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.createNote({
      name: 'Idea 42',
      content: 'first thought',
    });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['create', 'name=Idea 42', 'content=first thought'],
      { timeout: 10_000 },
    );
  });

  it('does NOT forward template= token to the CLI (handler renders templates in-process)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    await provider.createNote({
      name: 'Idea 42',
      template: 'idea',
    });

    expect(exec).toHaveBeenCalledWith('obsidian', ['create', 'name=Idea 42'], {
      timeout: 10_000,
    });
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

describe('ObsidianCLIProvider daily', () => {
  it('readDaily resolves path from daily:path and parses frontmatter from daily:read', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Daily/2026-04-25.md\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '---\nmood: ok\n---\n# Today\n',
        stderr: '',
      });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readDaily();

    expect(exec).toHaveBeenNthCalledWith(1, 'obsidian', ['daily:path'], { timeout: 10_000 });
    expect(exec).toHaveBeenNthCalledWith(2, 'obsidian', ['daily:read'], { timeout: 10_000 });
    expect(result).toEqual({
      path: 'Daily/2026-04-25.md',
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
  });

  it('readDaily returns frontmatter null when daily note has no frontmatter', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Daily/2026-04-25.md\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '# Today\nno yaml here\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: 'Daily/2026-04-25.md',
      frontmatter: null,
      content: '# Today\nno yaml here\n',
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
      provider.setProperty({
        identifier: { kind: 'name', value: 'foo' },
        name: 'k',
        value: 'v',
      }),
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
      provider.setProperty({
        identifier: { kind: 'name', value: 'foo' },
        name: 'k',
        value: 'v',
      }),
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

  it('maps stderr "not found" on edit to NOT_FOUND', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'File not found' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.setProperty({
        identifier: { kind: 'path', value: 'missing.md' },
        name: 'k',
        value: 'v',
      }),
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
      provider.setProperty({
        identifier: { kind: 'name', value: 'x' },
        name: 'k',
        value: 'v',
      }),
    ).rejects.toMatchObject({ code: 'CLI_TIMEOUT' });
  });

  it('maps anything else to CLI_ERROR with stderr in details', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('exit 2'), { code: 2, stdout: '', stderr: 'weird thing happened' }),
      );
    const provider = new ObsidianCLIProvider({ exec });

    await expect(
      provider.setProperty({
        identifier: { kind: 'name', value: 'x' },
        name: 'k',
        value: 'v',
      }),
    ).rejects.toSatisfy((err: ToolHandlerError) => {
      return err.code === 'CLI_ERROR' && err.details?.stderr === 'weird thing happened';
    });
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

  it('prepends vault token before the command when vaultName is set', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'Brain' });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'k',
      value: 'v',
      type: 'text',
    });

    const args = exec.mock.calls[0][1] as string[];
    expect(args[0]).toBe('vault=Brain');
    expect(args[1]).toBe('property:set');
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

    expect(exec).toHaveBeenCalledWith('obsidian', ['property:remove', 'name=status', 'path=a.md'], {
      timeout: 10_000,
    });
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

describe('ObsidianCLIProvider — VAULT_NOT_FOUND mapping', () => {
  it('maps stderr "vault not found" to VAULT_NOT_FOUND, not NOT_FOUND', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'vault not found: Brain',
      message: 'exited with code 1',
    });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'Brain' });

    await expect(provider.createNote({ path: 'a.md', content: 'x' })).rejects.toMatchObject({
      code: 'VAULT_NOT_FOUND',
    });
  });

  it('VAULT_NOT_FOUND message names the unrecognized vault and points at the alias/basename mismatch', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'vault does not exist: Brain',
      message: 'exited with code 1',
    });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'Brain' });

    try {
      await provider.createNote({ path: 'a.md', content: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      const e = err as ToolHandlerError;
      expect(e.code).toBe('VAULT_NOT_FOUND');
      expect(e.message).toMatch(/Brain/);
      expect(e.message).toMatch(/basename|Manage vaults/);
      expect(e.message).not.toMatch(/--vault-name/);
    }
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

    expect(exec).toHaveBeenCalledWith('obsidian', ['tags', 'counts', 'sort=count', 'format=json'], {
      timeout: 10_000,
    });
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

  it('treats "No tags found." plain-text sentinel as an empty list', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'No tags found.\n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    expect(await provider.listTags()).toEqual([]);
  });
});

describe('ObsidianCLIProvider stdout sentinel handling', () => {
  it('listProperties: treats "No properties found." sentinel as empty', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'No properties found.', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    expect(await provider.listProperties()).toEqual([]);
  });

  it('translates stdout "Vault not found." to VAULT_NOT_FOUND with actionable hint', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'Vault not found.', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'wrong-name' });
    await expect(provider.listTags()).rejects.toMatchObject({
      code: 'VAULT_NOT_FOUND',
      message: expect.stringContaining('Open the vault in Obsidian'),
      details: { vaultName: 'wrong-name' },
    });
  });

  it('returns empty array when stdout is empty (no JSON, no sentinel)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '   \n', stderr: '' });
    const provider = new ObsidianCLIProvider({ exec });
    expect(await provider.listTags()).toEqual([]);
  });
});

describe('ObsidianCLIProvider.createNote — template= drop and post-stat', () => {
  it('drops template= token (handler is responsible for rendering)', async () => {
    const calls: { args: string[] }[] = [];
    const exec = vi.fn(async (_bin: string, args: string[], _opts: { timeout: number }) => {
      calls.push({ args });
      return { stdout: '', stderr: '' };
    });
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'v' });
    await provider.createNote({ path: 'Foo.md', template: 'daily', content: 'rendered' });
    const tokens = calls[0]!.args;
    expect(tokens.some((t) => t.startsWith('template='))).toBe(false);
    expect(tokens.some((t) => t.startsWith('content='))).toBe(true);
  });

  it('post-stats the written file when vaultRoot is provided and throws CREATE_FAILED if missing', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'nv-prov-'));
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'v', vaultRoot: tmp });
    await expect(
      provider.createNote({ path: 'Missing.md', content: 'x' }),
    ).rejects.toMatchObject({ code: 'CREATE_FAILED' });
  });

  it('post-stat passes when the file actually exists', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'nv-prov-'));
    await writeFile(path.join(tmp, 'Real.md'), 'x');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'v', vaultRoot: tmp });
    const result = await provider.createNote({ path: 'Real.md', content: 'x' });
    expect(result.path).toBe('Real.md');
  });

  it('post-stat skipped when vaultRoot is undefined (legacy compat)', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const provider = new ObsidianCLIProvider({ exec, vaultName: 'v' });
    const result = await provider.createNote({ path: 'Whatever.md', content: 'x' });
    expect(result.path).toBe('Whatever.md');
  });
});
