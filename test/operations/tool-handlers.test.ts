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
    setProperty: vi.fn().mockResolvedValue(undefined),
    readProperty: vi.fn().mockResolvedValue({ value: '' }),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    listProperties: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    getTag: vi.fn().mockResolvedValue({ name: '', count: 0 }),
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
    await expect(handlers.readNote({ name: 'a', path: 'b.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.readNote({ path: '../../etc/passwd' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects Windows absolute paths', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.readNote({ path: 'C:/vault/note.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
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
    await expect(handlers.createNote({ content: 'hello' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
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

describe('operations.editNote handler', () => {
  it('forwards identifier, content, and position', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.editNote({
      path: 'Notes/x.md',
      content: 'tail',
      position: 'append',
    });

    expect(provider.editNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      content: 'tail',
      position: 'append',
    });
  });

  it('rejects invalid path', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(
      handlers.editNote({ path: '../bad', content: 'x', position: 'append' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('operations.readDaily handler', () => {
  it('forwards to provider.readDaily and returns the result', async () => {
    const provider = fakeProvider({
      readDaily: vi.fn().mockResolvedValue({ path: 'Daily/2026-04-25.md', content: 'today' }),
    });
    const handlers = createOperationsHandlers({ provider });

    const result = await handlers.readDaily({});

    expect(provider.readDaily).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ path: 'Daily/2026-04-25.md', content: 'today' });
  });
});

describe('operations.appendDaily handler', () => {
  it('forwards content', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.appendDaily({ content: '- task' });

    expect(provider.appendDaily).toHaveBeenCalledWith({ content: '- task' });
  });

  it('rejects empty content', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.appendDaily({ content: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('operations.setProperty handler', () => {
  it('infers type=text for string value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.setProperty({ path: 'a.md', name: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
      value: 'done',
      type: 'text',
    });
  });

  it('infers type=number for number value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.setProperty({ path: 'a.md', name: 'priority', value: 3 });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, type: 'number' }),
    );
  });

  it('infers type=checkbox for boolean value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.setProperty({ path: 'a.md', name: 'done', value: true });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: true, type: 'checkbox' }),
    );
  });

  it('infers type=list for array value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.setProperty({ path: 'a.md', name: 'tags', value: ['mcp', 'todo'] });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['mcp', 'todo'], type: 'list' }),
    );
  });

  it('explicit type overrides inference', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await handlers.setProperty({ path: 'a.md', name: 'due', value: '2026-05-01', type: 'date' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01', type: 'date' }),
    );
  });

  it('rejects array element containing comma', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await expect(
      handlers.setProperty({ path: 'a.md', name: 'tags', value: ['hello, world', 'ok'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects null/undefined value with UNSUPPORTED_VALUE_TYPE', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });

    await expect(
      handlers.setProperty({ path: 'a.md', name: 'x', value: null as unknown as string }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_VALUE_TYPE' });
  });

  it('rejects neither file nor path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });
    await expect(
      handlers.setProperty({ name: 'x', value: 'y' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects both file and path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider });
    await expect(
      handlers.setProperty({ file: 'a', path: 'b.md', name: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('operations.readProperty handler', () => {
  it('forwards to provider with resolved path target', async () => {
    const provider = fakeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 'done' }),
    });
    const handlers = createOperationsHandlers({ provider });

    const result = await handlers.readProperty({ path: 'a.md', name: 'status' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ value: 'done' });
  });

  it('forwards file target via wikilink kind', async () => {
    const provider = fakeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 42 }),
    });
    const handlers = createOperationsHandlers({ provider });

    await handlers.readProperty({ file: 'My Note', name: 'priority' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'My Note' },
      name: 'priority',
    });
  });

  it('rejects when neither file nor path', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.readProperty({ name: 'x' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
