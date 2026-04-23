import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GrepSearchProvider, ObsidianCliSearchProvider } from '../src/text-search.js';

describe('GrepSearchProvider', () => {
  it('isAvailable returns true', async () => {
    const provider = new GrepSearchProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('finds matching lines in vault .md files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    try {
      await fs.writeFile(path.join(tempDir, 'note-a.md'), 'hello world\nsome other line\n');
      await fs.writeFile(path.join(tempDir, 'note-b.md'), 'nothing here\nanother line\n');

      const provider = new GrepSearchProvider();
      const results = await provider.search('hello', tempDir, 10);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('note-a.md');
      expect(results[0].lineNumber).toBe(1);
      expect(results[0].matchLine).toContain('hello world');
    } finally {
      await fs.rm(tempDir, { recursive: true });
    }
  });

  it('returns empty array when nothing matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    try {
      await fs.writeFile(path.join(tempDir, 'note-a.md'), 'hello world\n');

      const provider = new GrepSearchProvider();
      const results = await provider.search('zzznomatchzzz', tempDir, 10);

      expect(results).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true });
    }
  });

  it('respects the limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    try {
      // Write a file with many matching lines
      const lines = Array.from({ length: 20 }, (_, i) => `keyword line ${i}`).join('\n');
      await fs.writeFile(path.join(tempDir, 'many.md'), lines + '\n');

      const provider = new GrepSearchProvider();
      const results = await provider.search('keyword', tempDir, 5);

      expect(results.length).toBeLessThanOrEqual(5);
    } finally {
      await fs.rm(tempDir, { recursive: true });
    }
  });

  it('only searches .md files and excludes .txt files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    try {
      await fs.writeFile(path.join(tempDir, 'note.txt'), 'uniquekeyword in txt file\n');
      await fs.writeFile(path.join(tempDir, 'other.md'), 'nothing relevant\n');

      const provider = new GrepSearchProvider();
      const results = await provider.search('uniquekeyword', tempDir, 10);

      expect(results).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true });
    }
  });
});

describe('ObsidianCliSearchProvider', () => {
  it('isAvailable returns a boolean', async () => {
    const provider = new ObsidianCliSearchProvider();
    const result = await provider.isAvailable();
    expect(typeof result).toBe('boolean');
  });
});
