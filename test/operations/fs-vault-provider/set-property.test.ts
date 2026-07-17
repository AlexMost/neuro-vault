import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { byName, byPath, makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider.setProperty (disk)', () => {
  it('sets a property preserving body bytes and neighbor formatting', async () => {
    const root = await makeVault({
      'x.md': '---\n# keep me\nstatus: todo\n---\nbody stays\r\nexactly\n',
    });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'priority', value: 2 });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('# keep me');
    expect(written).toContain('priority: 2');
    expect(written.endsWith('body stays\r\nexactly\n')).toBe(true);
  });

  it('creates a frontmatter block when the note has none', async () => {
    const root = await makeVault({ 'x.md': 'just body\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'status', value: 'todo' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(
      '---\nstatus: todo\n---\njust body\n',
    );
  });

  it('writes real YAML lists for array values', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({
      identifier: byPath('x.md'),
      name: 'tags',
      value: ['alpha', 'beta'],
      type: 'list',
    });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toMatch(/tags:\n\s+- alpha\n\s+- beta/);
  });

  it('resolves kind:name via the basename index', async () => {
    const root = await makeVault({ 'Deep/Idea 42.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byName('Idea 42'), name: 'a', value: 2 });

    const written = await readFile(path.join(root, 'Deep/Idea 42.md'), 'utf8');
    expect(written).toContain('a: 2');
  });

  it('fails NOT_FOUND when kind:name unresolvable', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await expect(
      provider.setProperty({ identifier: byName('Nope'), name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails READ_FAILED on unparsable existing frontmatter YAML', async () => {
    const root = await makeVault({ 'x.md': '---\na: [1, 2\n---\nbody\n' });
    const provider = makeProvider(root);

    await expect(
      provider.setProperty({ identifier: byPath('x.md'), name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'READ_FAILED' });
  });

  it('fails NOT_FOUND when the note does not exist on disk', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    await expect(
      provider.setProperty({ identifier: byPath('missing.md'), name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('never touches .obsidian/types.json', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({
      identifier: byPath('x.md'),
      name: 'due',
      value: '2026-08-01',
      type: 'date',
    });

    await expect(readFile(path.join(root, '.obsidian/types.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it("overwrites an existing key's value", async () => {
    const root = await makeVault({ 'x.md': '---\nstatus: todo\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'status', value: 'done' });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('status: done');
    expect(written).not.toContain('todo');
  });

  it('writes a number value as a YAML number, not a quoted string', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'priority', value: 5 });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toMatch(/priority: 5\b/);
  });

  it('writes a boolean value', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'done', value: true });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('done: true');
  });

  it('ISO date value stays an unquoted plain scalar', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({
      identifier: byPath('x.md'),
      name: 'due',
      value: '2026-08-01',
      type: 'date',
    });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('due: 2026-08-01');
    expect(written).not.toContain('"2026-08-01"');
    expect(written).not.toContain("'2026-08-01'");
  });

  it('setting one key preserves sibling keys and the body', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\nb: 2\n---\nBODY\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'c', value: 3 });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('a: 1');
    expect(written).toContain('b: 2');
    expect(written).toContain('c: 3');
    expect(written.endsWith('BODY\n')).toBe(true);
  });

  it("kind:'path' identifier without extension is normalized", async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x'), name: 'a', value: 2 });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('a: 2');
  });

  it('setting a property on a note with an empty frontmatter block adds the key', async () => {
    const root = await makeVault({ 'x.md': '---\n---\nbody\n' });
    const provider = makeProvider(root);

    await provider.setProperty({ identifier: byPath('x.md'), name: 'key', value: 'value' });

    const written = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(written).toContain('key: value');
    expect(written.endsWith('body\n')).toBe(true);
  });
});
