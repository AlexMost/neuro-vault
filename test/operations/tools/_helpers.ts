import { vi } from 'vitest';

import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import type { VaultReader, ReadNotesItem } from '../../../src/lib/obsidian/vault-reader.js';

export function makeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    editNote: vi.fn().mockResolvedValue(undefined),
    readDaily: vi.fn().mockResolvedValue({ path: '', frontmatter: null, content: '' }),
    appendDaily: vi.fn().mockResolvedValue(undefined),
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
