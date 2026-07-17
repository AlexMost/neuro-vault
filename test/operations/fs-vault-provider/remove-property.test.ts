import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { byName, byPath, makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider.removeProperty (disk)', () => {
  it('is idempotent on absent keys (no rewrite)', async () => {
    const src = '---\nstatus:   todo   # odd spacing preserved\n---\n';
    const root = await makeVault({ 'x.md': src });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'missing' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(src);
  });

  it('removes a property; removing the last key strips the block', async () => {
    const root = await makeVault({ 'x.md': '---\nstatus: todo\n---\nbody\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'status' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('body\n');
  });

  it('removes one key among several, preserving the rest and the body', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\nb: 2\nc: 3\n---\nBODY\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'b' });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toContain('a: 1');
    expect(out).toContain('c: 3');
    expect(out).not.toContain('b:');
    expect(out.endsWith('BODY\n')).toBe(true);
  });

  it('preserves a comment on a remaining key when deleting a different key', async () => {
    const root = await makeVault({ 'x.md': '---\nkeep: 1 # note\ndrop: 2\n---\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'drop' });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toContain('keep: 1 # note');
    expect(out).not.toContain('drop:');
  });

  it('resolves kind:name via the basename index', async () => {
    const root = await makeVault({ 'Deep/Idea 42.md': '---\na: 1\nb: 2\n---\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byName('Idea 42'), name: 'a' });

    const out = await readFile(path.join(root, 'Deep/Idea 42.md'), 'utf8');
    expect(out).not.toContain('a:');
    expect(out).toContain('b: 2');
  });

  it('keeps inline and tail comments when removing the last key (yaml caveat pin)', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1 # inline\nlast: x\n# tail\n---\nbody\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'last' });

    // Documented `yaml` caveat pin: deleting the key before a tail comment
    // keeps both remaining comments; a blank line replaces the removed entry.
    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(
      '---\na: 1 # inline\n\n# tail\n---\nbody\n',
    );
  });

  it('fails AMBIGUOUS_MATCH when two notes share the basename, removing from neither', async () => {
    const before = '---\na: 1\n---\n';
    const root = await makeVault({
      'A/Meeting Notes.md': before,
      'B/Meeting Notes.md': before,
    });
    const provider = makeProvider(root);

    await expect(
      provider.removeProperty({ identifier: byName('Meeting Notes'), name: 'a' }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_MATCH',
      details: {
        name: 'Meeting Notes',
        matches: ['A/Meeting Notes.md', 'B/Meeting Notes.md'],
      },
    });

    expect(await readFile(path.join(root, 'A/Meeting Notes.md'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, 'B/Meeting Notes.md'), 'utf8')).toBe(before);
  });

  it('fails NOT_FOUND when the note does not exist on disk', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    await expect(
      provider.removeProperty({ identifier: byPath('missing.md'), name: 'a' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails NOT_FOUND when kind:name is unresolvable', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = makeProvider(root);

    await expect(
      provider.removeProperty({ identifier: byName('Nope'), name: 'a' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails READ_FAILED on unparsable existing frontmatter YAML', async () => {
    const root = await makeVault({ 'x.md': '---\na: [1, 2\n---\nbody\n' });
    const provider = makeProvider(root);

    await expect(
      provider.removeProperty({ identifier: byPath('x.md'), name: 'a' }),
    ).rejects.toMatchObject({ code: 'READ_FAILED' });
  });

  it('is a no-op when removing a key from a note with no frontmatter at all', async () => {
    const src = 'just body\n';
    const root = await makeVault({ 'x.md': src });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'status' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(src);
  });

  it('normalizes a kind:path identifier without an extension', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\nb: 2\n---\n' });
    const provider = makeProvider(root);

    await provider.removeProperty({ identifier: byPath('x'), name: 'a' });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).not.toContain('a:');
    expect(out).toContain('b: 2');
  });
});
