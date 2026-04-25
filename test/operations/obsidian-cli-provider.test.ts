import { describe, expect, it, vi } from 'vitest';

import { ObsidianCLIProvider } from '../../src/modules/operations/obsidian-cli-provider.js';

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

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['read', 'path=Folder/note.md'],
      { timeout: 10_000 },
    );
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

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['create', 'path=Inbox/x.md', 'overwrite'],
      { timeout: 10_000 },
    );
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

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['append', 'file=Notes', 'content=new line'],
      { timeout: 10_000 },
    );
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
