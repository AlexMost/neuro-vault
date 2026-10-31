import path from 'node:path';

import { vi } from 'vitest';

import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { VaultReader, ReadNotesItem } from '../../../src/lib/obsidian/vault-reader.js';

export function makeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    readDaily: vi.fn().mockResolvedValue({ path: '', frontmatter: null, content: '' }),
    setProperty: vi.fn().mockResolvedValue(undefined),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    replaceInNote: vi.fn().mockResolvedValue(undefined),
    replaceFullBody: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function makeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  return {
    readNotes: vi.fn().mockResolvedValue([] as ReadNotesItem[]),
    scan: vi.fn().mockResolvedValue([] as string[]),
    ...overrides,
  };
}

/**
 * A reader over in-memory note files, keyed by vault-relative path. It is the real
 * `FsVaultReader` over a fake filesystem, so `frontmatter` / `content` come through
 * `splitFrontmatter` and `raw` is the file verbatim; a path not in the map is NOT_FOUND.
 */
export function readerOverFiles(files: Record<string, string>): VaultReader {
  const root = '/vault';
  const byAbs = new Map(Object.entries(files).map(([p, text]) => [path.join(root, p), text]));
  return new FsVaultReader({
    vaultRoot: root,
    readFile: async (absPath: string) => {
      const text = byAbs.get(absPath);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: 'ENOENT' });
      }
      return text;
    },
    glob: async () => Object.keys(files),
  });
}

/**
 * A reader over an in-memory note map. Tags and properties are derived from
 * what the reader yields, so a tool's `top_tags` / `properties` are set up by
 * seeding notes rather than by stubbing an aggregate method.
 */
export function readerOver(
  notes: Record<string, { frontmatter?: Record<string, unknown>; content?: string }>,
): VaultReader {
  return {
    scan: vi.fn().mockResolvedValue(Object.keys(notes)),
    readNotes: vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map(
        (p): ReadNotesItem => ({
          path: p,
          frontmatter: notes[p]?.frontmatter ?? {},
          content: notes[p]?.content ?? '',
        }),
      ),
    ),
  };
}
