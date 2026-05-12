import { vi } from 'vitest';

import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import type { VaultReader, ReadNotesItem } from '../../../src/lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../../src/lib/obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

export function makeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    readDaily: vi.fn().mockResolvedValue({ path: '', frontmatter: null, content: '' }),
    setProperty: vi.fn().mockResolvedValue(undefined),
    readProperty: vi.fn().mockResolvedValue({ value: '' }),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    listProperties: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
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

export function makeWriter(overrides: Partial<VaultWriter> = {}): VaultWriter {
  return {
    replaceInNote: vi.fn().mockResolvedValue(undefined),
    replaceFullBody: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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
