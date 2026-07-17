import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider.createNote (disk)', () => {
  it('writes content verbatim and creates parent folders', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    const result = await provider.createNote({
      path: 'Deep/Nested/x.md',
      content: '---\na: 1\n---\nbody\n',
    });

    expect(result).toEqual({ path: 'Deep/Nested/x.md' });
    expect(await readFile(path.join(root, 'Deep/Nested/x.md'), 'utf8')).toBe(
      '---\na: 1\n---\nbody\n',
    );
  });

  it('fails NOTE_EXISTS without overwrite, succeeds with it', async () => {
    const root = await makeVault({ 'x.md': 'old' });
    const provider = makeProvider(root);

    await expect(provider.createNote({ path: 'x.md', content: 'new' })).rejects.toMatchObject({
      code: 'NOTE_EXISTS',
      details: { path: 'x.md' },
    });
    await provider.createNote({ path: 'x.md', content: 'new', overwrite: true });
    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('new');
  });

  it('resolves name via app.json newFileFolderPath', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}',
    });
    const provider = makeProvider(root);

    const result = await provider.createNote({ name: 'Idea 42' });

    expect(result).toEqual({ path: 'Inbox/Idea 42.md' });
  });

  it('resolves name to vault root without app.json', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });

  it('throws when neither name nor path is given', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    await expect(provider.createNote({})).rejects.toThrow('createNote requires name or path');
  });

  it('writes an empty file when content is omitted', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    const result = await provider.createNote({ path: 'empty.md' });

    expect(result).toEqual({ path: 'empty.md' });
    expect(await readFile(path.join(root, 'empty.md'), 'utf8')).toBe('');
  });

  it('overwrite: true fully replaces prior longer content', async () => {
    const root = await makeVault({ 'x.md': 'AAAAA long old' });
    const provider = makeProvider(root);

    await provider.createNote({ path: 'x.md', content: 'new', overwrite: true });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('new');
  });

  it('resolves name to vault root when newFileLocation is not "folder"', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"root"}',
    });
    const provider = makeProvider(root);

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });

  it('falls back to vault root when app.json is malformed JSON', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{not json',
    });
    const provider = makeProvider(root);

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });

  it('trims a trailing slash on newFileFolderPath', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Inbox/"}',
    });
    const provider = makeProvider(root);

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Inbox/Idea.md' });
  });

  it('resolves name to vault root when newFileFolderPath is empty', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":""}',
    });
    const provider = makeProvider(root);

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });

  it('creates parent folders that do not exist yet', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Deep/Nested"}',
    });
    const provider = makeProvider(root);

    const result = await provider.createNote({ name: 'Idea' });

    expect(result).toEqual({ path: 'Deep/Nested/Idea.md' });
    expect(await readFile(path.join(root, 'Deep/Nested/Idea.md'), 'utf8')).toBe('');
  });
});
