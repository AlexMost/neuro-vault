import { describe, expect, it, vi } from 'vitest';

import { createOperationsHandlers } from '../../src/modules/operations/tool-handlers.js';
import type { VaultProvider } from '../../src/modules/operations/vault-provider.js';
import type { VaultReader, ReadNotesItem } from '../../src/modules/operations/vault-reader.js';

function fakeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
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
    getTag: vi.fn().mockResolvedValue({ name: '', count: 0 }),
    ...overrides,
  };
}

function fakeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  return {
    readNotes: vi.fn().mockResolvedValue([] as ReadNotesItem[]),
    scan: vi.fn().mockResolvedValue([] as string[]),
    ...overrides,
  };
}

describe('operations.readNotes handler', () => {
  it('reads a single path with default fields', async () => {
    const reader = fakeReader({
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['Folder/n.md'] });

    expect(reader.readNotes).toHaveBeenCalledWith({
      paths: ['Folder/n.md'],
      fields: ['frontmatter', 'content'],
    });
    expect(result).toEqual({
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
      count: 1,
      errors: 0,
    });
  });

  it('dedupes paths preserving first-occurrence order', async () => {
    const reader = fakeReader({
      readNotes: vi.fn().mockResolvedValue([
        { path: 'a.md', frontmatter: null, content: '' },
        { path: 'b.md', frontmatter: null, content: '' },
      ]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['a.md', 'b.md', 'a.md'] });

    expect(reader.readNotes).toHaveBeenCalledWith({
      paths: ['a.md', 'b.md'],
      fields: ['frontmatter', 'content'],
    });
    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it("projects 'frontmatter' only when fields excludes 'content'", async () => {
    const reader = fakeReader({
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { x: 1 }, content: 'body' }]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['a.md'], fields: ['frontmatter'] });

    expect(result.results[0]).toEqual({ path: 'a.md', frontmatter: { x: 1 } });
    expect((result.results[0] as { content?: string }).content).toBeUndefined();
  });

  it("projects 'content' only when fields excludes 'frontmatter'", async () => {
    const reader = fakeReader({
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { x: 1 }, content: 'body' }]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['a.md'], fields: ['content'] });

    expect(result.results[0]).toEqual({ path: 'a.md', content: 'body' });
    expect((result.results[0] as { frontmatter?: unknown }).frontmatter).toBeUndefined();
  });

  it('rejects 0 paths with INVALID_ARGUMENT (top-level)', async () => {
    const handlers = createOperationsHandlers({
      provider: fakeProvider(),
      reader: fakeReader(),
    });
    await expect(handlers.readNotes({ paths: [] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects 51 paths with INVALID_ARGUMENT (top-level)', async () => {
    const handlers = createOperationsHandlers({
      provider: fakeProvider(),
      reader: fakeReader(),
    });
    const paths = Array.from({ length: 51 }, (_, i) => `n${i}.md`);
    await expect(handlers.readNotes({ paths })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects empty fields with INVALID_ARGUMENT (top-level)', async () => {
    const handlers = createOperationsHandlers({
      provider: fakeProvider(),
      reader: fakeReader(),
    });
    await expect(handlers.readNotes({ paths: ['a.md'], fields: [] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects unknown field with INVALID_ARGUMENT (top-level)', async () => {
    const handlers = createOperationsHandlers({
      provider: fakeProvider(),
      reader: fakeReader(),
    });
    await expect(
      handlers.readNotes({ paths: ['a.md'], fields: ['mtime' as unknown as 'frontmatter'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('produces per-item INVALID_ARGUMENT for traversal paths and reads the rest', async () => {
    const reader = fakeReader({
      readNotes: vi.fn().mockResolvedValue([{ path: 'a.md', frontmatter: null, content: 'a' }]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['a.md', '../etc/passwd'] });

    expect(reader.readNotes).toHaveBeenCalledWith({
      paths: ['a.md'],
      fields: ['frontmatter', 'content'],
    });
    expect(result.count).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.results[0]).toMatchObject({ path: 'a.md' });
    expect(result.results[1]).toMatchObject({
      path: '../etc/passwd',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('produces per-item INVALID_ARGUMENT for absolute paths', async () => {
    const reader = fakeReader({ readNotes: vi.fn().mockResolvedValue([]) });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['/absolute.md'] });

    expect(result.results).toEqual([
      {
        path: '/absolute.md',
        error: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      },
    ]);
    expect(result.errors).toBe(1);
  });

  it('passes through per-item NOT_FOUND from the reader', async () => {
    const reader = fakeReader({
      readNotes: vi.fn().mockResolvedValue([
        { path: 'a.md', frontmatter: null, content: 'a' },
        { path: 'missing.md', error: { code: 'NOT_FOUND', message: 'Note not found: missing.md' } },
      ]),
    });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({ paths: ['a.md', 'missing.md'] });

    expect(result.errors).toBe(1);
    expect(result.results[1]).toMatchObject({
      path: 'missing.md',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('replaces 8 read_property calls: 8 paths with fields=[frontmatter]', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `t${i}.md`,
      frontmatter: { status: i % 2 === 0 ? 'done' : 'todo' },
      content: 'body',
    }));
    const reader = fakeReader({ readNotes: vi.fn().mockResolvedValue(items) });
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader });

    const result = await handlers.readNotes({
      paths: items.map((i) => i.path),
      fields: ['frontmatter'],
    });

    expect(result.count).toBe(8);
    expect(result.errors).toBe(0);
    expect(result.results.every((r) => 'frontmatter' in r && !('content' in r))).toBe(true);
  });
});

describe('operations.createNote handler', () => {
  it('forwards normalized fields to provider.createNote', async () => {
    const provider = fakeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/idea.md' }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

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
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(handlers.createNote({ content: 'hello' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(
      handlers.createNote({ path: '../../etc/passwd', content: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('rejects Unix absolute path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(handlers.createNote({ path: '/tmp/escape.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('rejects Windows absolute path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(handlers.createNote({ path: 'C:\\Users\\me\\note.md' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('normalizes path before forwarding', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.createNote({ path: './Inbox/x.md' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Inbox/x.md' }),
    );
  });
});

describe('operations.editNote handler', () => {
  it('forwards identifier, content, and position', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

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
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(
      handlers.editNote({ path: '../bad', content: 'x', position: 'append' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Unix absolute path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(
      handlers.editNote({ path: '/etc/passwd', content: 'x', position: 'append' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.editNote).not.toHaveBeenCalled();
  });
});

describe('operations.readDaily handler', () => {
  it('forwards to provider.readDaily and returns the result', async () => {
    const provider = fakeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-04-25.md', frontmatter: null, content: 'today' }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    const result = await handlers.readDaily({});

    expect(provider.readDaily).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      path: 'Daily/2026-04-25.md',
      frontmatter: null,
      content: 'today',
    });
  });
});

describe('operations.appendDaily handler', () => {
  it('forwards content', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.appendDaily({ content: '- task' });

    expect(provider.appendDaily).toHaveBeenCalledWith({ content: '- task' });
  });

  it('rejects empty content', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(handlers.appendDaily({ content: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('operations.setProperty handler', () => {
  it('infers type=text for string value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({ path: 'a.md', key: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
      value: 'done',
      type: 'text',
    });
  });

  it('infers type=number for number value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({ path: 'a.md', key: 'priority', value: 3 });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, type: 'number' }),
    );
  });

  it('infers type=checkbox for boolean value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({ path: 'a.md', key: 'done', value: true });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: true, type: 'checkbox' }),
    );
  });

  it('infers type=list for array value', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({ path: 'a.md', key: 'tags', value: ['mcp', 'todo'] });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['mcp', 'todo'], type: 'list' }),
    );
  });

  it('explicit type overrides inference', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({ path: 'a.md', key: 'due', value: '2026-05-01', type: 'date' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01', type: 'date' }),
    );
  });

  it('rejects non-ISO date format with INVALID_ARGUMENT', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({ path: 'a.md', key: 'due', value: '03.05.2026', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects logically invalid date with INVALID_ARGUMENT', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({ path: 'a.md', key: 'due', value: '2026-13-45', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects non-string value when type=date', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({
        path: 'a.md',
        key: 'due',
        value: 12345 as unknown as string,
        type: 'date',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('accepts ISO datetime with explicit type=datetime', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.setProperty({
      path: 'a.md',
      key: 'startedAt',
      value: '2026-05-01T14:30:00Z',
      type: 'datetime',
    });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01T14:30:00Z', type: 'datetime' }),
    );
  });

  it('rejects space-separated datetime as non-ISO', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({
        path: 'a.md',
        key: 'startedAt',
        value: '2026-05-01 14:30:00',
        type: 'datetime',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects array element containing comma', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({ path: 'a.md', key: 'tags', value: ['hello, world', 'ok'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects null/undefined value with UNSUPPORTED_VALUE_TYPE', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await expect(
      handlers.setProperty({ path: 'a.md', key: 'x', value: null as unknown as string }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_VALUE_TYPE' });
  });

  it('rejects when neither name nor path is provided', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(handlers.setProperty({ key: 'x', value: 'y' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when both name and path are provided', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(
      handlers.setProperty({ name: 'a', path: 'b.md', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects path traversal', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(
      handlers.setProperty({ path: '../../etc/passwd', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(
      handlers.setProperty({ path: '/tmp/x.md', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });
});

describe('operations.readProperty handler', () => {
  it('forwards to provider with resolved path target', async () => {
    const provider = fakeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 'done' }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    const result = await handlers.readProperty({ path: 'a.md', key: 'status' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
    });
    expect(result).toEqual({ value: 'done' });
  });

  it('forwards name target via wikilink kind', async () => {
    const provider = fakeProvider({
      readProperty: vi.fn().mockResolvedValue({ value: 42 }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.readProperty({ name: 'My Note', key: 'priority' });

    expect(provider.readProperty).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'My Note' },
      name: 'priority',
    });
  });

  it('rejects when neither name nor path is provided', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(handlers.readProperty({ key: 'x' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('operations.removeProperty handler', () => {
  it('returns { ok: true } on success', async () => {
    const provider = fakeProvider({
      removeProperty: vi.fn().mockResolvedValue(undefined),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    const result = await handlers.removeProperty({ path: 'a.md', key: 'status' });

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
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    expect(await handlers.removeProperty({ path: 'a.md', key: 'gone' })).toEqual({ ok: true });
  });

  it('rejects empty name with INVALID_ARGUMENT', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(handlers.removeProperty({ path: 'a.md', key: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects path traversal', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(handlers.removeProperty({ path: '../escape.md', key: 'x' })).rejects.toMatchObject(
      { code: 'INVALID_ARGUMENT' },
    );
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = fakeProvider();
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    await expect(handlers.removeProperty({ path: '/etc/passwd', key: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.removeProperty).not.toHaveBeenCalled();
  });
});

describe('operations.listProperties handler', () => {
  it('forwards to provider', async () => {
    const provider = fakeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 5 }]),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    expect(await handlers.listProperties({})).toEqual([{ name: 'status', count: 5 }]);
    expect(provider.listProperties).toHaveBeenCalled();
  });
});

describe('operations.listTags handler', () => {
  it('forwards to provider', async () => {
    const provider = fakeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 3 }]),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });
    expect(await handlers.listTags({})).toEqual([{ name: 'mcp', count: 3 }]);
    expect(provider.listTags).toHaveBeenCalled();
  });
});

describe('operations.getTag handler', () => {
  it('strips leading # from tag', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1, files: ['a.md'] }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.getTag({ tag: '#mcp' });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: true });
  });

  it('passes includeFiles=false when include_files is false', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1 }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.getTag({ tag: 'mcp', include_files: false });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: false });
  });

  it('defaults includeFiles=true when include_files is omitted', async () => {
    const provider = fakeProvider({
      getTag: vi.fn().mockResolvedValue({ name: 'mcp', count: 1, files: [] }),
    });
    const handlers = createOperationsHandlers({ provider, reader: fakeReader() });

    await handlers.getTag({ tag: 'mcp' });

    expect(provider.getTag).toHaveBeenCalledWith({ name: 'mcp', includeFiles: true });
  });

  it('rejects when tag is empty', async () => {
    const handlers = createOperationsHandlers({ provider: fakeProvider(), reader: fakeReader() });
    await expect(handlers.getTag({ tag: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(handlers.getTag({ tag: '#' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
