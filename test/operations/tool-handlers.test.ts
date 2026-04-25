import { describe, expect, it, vi } from 'vitest';

import { createOperationsHandlers } from '../../src/modules/operations/tool-handlers.js';
import type { VaultProvider } from '../../src/modules/operations/vault-provider.js';

function fakeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    readNote: vi.fn().mockResolvedValue({ path: '', content: '' }),
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    editNote: vi.fn().mockResolvedValue(undefined),
    readDaily: vi.fn().mockResolvedValue({ path: '', content: '' }),
    appendDaily: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('operations.readNote handler', () => {
  it('forwards a name identifier to the provider', async () => {
    const provider = fakeProvider({
      readNote: vi.fn().mockResolvedValue({ path: 'Folder/note.md', content: 'body' }),
    });
    const handlers = createOperationsHandlers({ provider });

    const result = await handlers.readNote({ name: 'My Note' });

    expect(provider.readNote).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'My Note' },
    });
    expect(result).toEqual({ path: 'Folder/note.md', content: 'body' });
  });

  it('forwards a path identifier to the provider', async () => {
    const provider = fakeProvider({
      readNote: vi.fn().mockResolvedValue({ path: 'Folder/note.md', content: 'body' }),
    });
    const handlers = createOperationsHandlers({ provider });

    await handlers.readNote({ path: 'Folder/note.md' });

    expect(provider.readNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Folder/note.md' },
    });
  });
});
