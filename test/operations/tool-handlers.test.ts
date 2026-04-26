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

describe('operations.removeProperty handler', () => {
  it('returns { ok: true } on success', async () => {
    const provider = fakeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const handlers = createOperationsHandlers({ provider });

    const result = await handlers.removeProperty({ path: 'a.md', name: 'status' });

    expect(provider.removeProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: true } even when provider already swallowed PROPERTY_NOT_FOUND', async () => {
    const provider = fakeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const handlers = createOperationsHandlers({ provider });
    expect(await handlers.removeProperty({ path: 'a.md', name: 'gone' })).toEqual({ ok: true });
  });
});

describe('operations.listProperties handler', () => {
  it('forwards to provider', async () => {
    const provider = fakeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 5 }]),
    });
    const handlers = createOperationsHandlers({ provider });
    expect(await handlers.listProperties({})).toEqual([{ name: 'status', count: 5 }]);
    expect(provider.listProperties).toHaveBeenCalled();
  });
});

describe('operations.listTags handler', () => {
  it('forwards to provider', async () => {
    const provider = fakeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 3 }]),
    });
    const handlers = createOperationsHandlers({ provider });
    expect(await handlers.listTags({})).toEqual([{ name: 'mcp', count: 3 }]);
  });
});

describe('operations.getTag handler', () => {
  it('strips leading # from tag name', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1, files: ['a.md'] }),
    });
    const handlers = createOperationsHandlers({ provider });

    await handlers.getTag({ name: '#mcp' });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: true });
  });

  it('passes includeFiles=false when include_files is false', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1 }),
    });
    const handlers = createOperationsHandlers({ provider });

    await handlers.getTag({ name: 'mcp', include_files: false });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: false });
  });

  it('defaults includeFiles=true when include_files is omitted', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1, files: [] }),
    });
    const handlers = createOperationsHandlers({ provider });

    await handlers.getTag({ name: 'mcp' });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: true });
  });

  it('rejects empty tag name', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider() });
    await expect(handlers.getTag({ name: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(handlers.getTag({ name: '#' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
