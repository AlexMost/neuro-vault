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

describe('operations.readNote validation', () => {
  it('rejects when neither name nor path is provided', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.readNote({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects when both name and path are provided', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(
      handlers.readNote({ name: 'a', path: 'b.md' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects path traversal', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(
      handlers.readNote({ path: '../../etc/passwd' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Windows absolute paths', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(
      handlers.readNote({ path: 'C:/vault/note.md' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('operations.createNote handler', () => {
  it('forwards normalized fields to provider.createNote', async () => {
    const provider = fakeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/idea.md' }),
    });
    const handlers = createOperationsHandlers({ provider });

    const result = await handlers.createNote({
      path: 'Inbox/idea.md',
      content: 'hello',
      template: 'idea',
      overwrite: true,
    });

    expect(provider.createNote).toHaveBeenCalledWith({
      path: 'Inbox/idea.md',
      content: 'hello',
      template: 'idea',
      overwrite: true,
    });
    expect(result).toEqual({ path: 'Inbox/idea.md' });
  });

  it('rejects when neither name nor path is provided', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(
      handlers.createNote({ content: 'hello' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('normalizes path before forwarding', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.createNote({ path: './Inbox/x.md' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Inbox/x.md' }),
    );
  });
});
