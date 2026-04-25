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
