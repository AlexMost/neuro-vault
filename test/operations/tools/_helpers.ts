import { vi } from 'vitest';

import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import type { VaultReader, ReadNotesItem } from '../../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

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

export function makeGraph(overrides: Partial<WikilinkGraphIndex> = {}): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
    ...overrides,
  } as unknown as WikilinkGraphIndex;
}
