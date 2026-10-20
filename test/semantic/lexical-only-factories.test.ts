import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import { createLexicalOnlyVaultFactories } from '../../src/modules/semantic/index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A vault where `Z.md` and `Y.md` tie on "zebra" and only `Z.md` has a backlink. */
async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-lexical-only-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'Y.md'), 'a zebra crossing\n');
  await fs.writeFile(path.join(root, 'Z.md'), 'a zebra crossing\n');
  await fs.writeFile(path.join(root, 'A.md'), 'see [[Z]]\n');
  return root;
}

/** Every `WikilinkGraphIndex` build, whichever instance runs it. */
const spyBuilds = () =>
  vi.spyOn(WikilinkGraphIndex.prototype as unknown as { rebuild: () => Promise<void> }, 'rebuild');

const SEARCH = { queries: ['zebra'], noteCap: 10, perNoteCap: 3 };

describe('createLexicalOnlyVaultFactories (--no-semantic)', () => {
  it('one graph per vault root: the graph reader and the lexical tie-break share its build', async () => {
    const builds = spyBuilds();
    const root = await makeVault();
    const reader = new FsVaultReader({ vaultRoot: root });
    const factories = createLexicalOnlyVaultFactories();
    const opts = { vaultRoot: root, vaultName: 'v', reader, enabled: true };
    const lexical = factories.lexicalReaderFactory(opts);
    const graph = factories.graphFactory(opts);

    const result = await lexical.search(SEARCH);
    expect(result.notes.map((n) => n.path)).toEqual(['Z.md', 'Y.md']);
    await expect(graph.backlinkCounts(['Z.md', 'Y.md'])).resolves.toEqual([1, 0]);
    expect(builds).toHaveBeenCalledTimes(1);
  });

  it('two vault roots get two graphs; two factory sets share nothing', async () => {
    const builds = spyBuilds();
    const first = await makeVault();
    const second = await makeVault();
    const factories = createLexicalOnlyVaultFactories();
    const graphOf = (root: string) =>
      factories.graphFactory({
        vaultRoot: root,
        vaultName: 'v',
        reader: new FsVaultReader({ vaultRoot: root }),
        enabled: true,
      });

    await graphOf(first).backlinkCounts(['Z.md']);
    await graphOf(second).backlinkCounts(['Z.md']);
    expect(builds).toHaveBeenCalledTimes(2);

    await createLexicalOnlyVaultFactories()
      .graphFactory({
        vaultRoot: first,
        vaultName: 'v',
        reader: new FsVaultReader({ vaultRoot: first }),
        enabled: true,
      })
      .backlinkCounts(['Z.md']);
    expect(builds).toHaveBeenCalledTimes(3);
  });
});
