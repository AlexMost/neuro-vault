import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastGlob from 'fast-glob';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../../../src/lib/obsidian/vault-scope-config.js';
import { FsVaultProvider } from '../../../src/modules/operations/fs-vault-provider.js';

let vaultRoot: string;

beforeAll(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'nv-scope-'));
  const write = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(vaultRoot, rel)), { recursive: true });
    await writeFile(path.join(vaultRoot, rel), content, 'utf8');
  };
  await write('Projects/alpha.md', '---\ntags: [kept]\n---\nSee [[beta]].');
  await write('Templates/Daily.md', '---\ntags: [tmpl]\nstatus: draft\n---\nTemplate body');
  await write('docs/superpowers/spec.md', '---\ntags: [ghost]\n---\nHidden');
  await write('Archive/old.md', '---\ntags: [old]\n---\nArchived');
  await write('.gitignore', 'docs/superpowers/\n!docs/superpowers/keep.md\n');
  await write('.neuro-vault/config.json', JSON.stringify({ exclusions: ['Archive/**'] }));
});

afterAll(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe('vault scope end-to-end (real temp-dir vault)', () => {
  it('scan sees only the in-scope note: glob view and predicate agree on a real tree', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const scanned = await reader.scan();
    expect(scanned).toEqual(['Projects/alpha.md']);

    // Spec vault-scope R1, scenario "Predicate and glob views agree": enumerate
    // the same tree independently — no `ignore`, so nothing is pruned at
    // traversal time — and filter with the predicate alone. `dot: false`
    // mirrors what the scan enumerates with; the predicate's dot rule is the
    // same restriction expressed the other way.
    const everything = await fastGlob('**/*.md', {
      cwd: vaultRoot,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
    const predicateOnly = everything.filter((p) => !scope.isExcluded(p)).sort();
    expect(predicateOnly).toEqual(scanned);
  });

  it('a prefixed scan over a real tree still honours the scope predicate', async () => {
    // The riskiest branch: fast-glob's cwd moves into the prefix, so the
    // root-anchored ignore patterns are deliberately not passed and the
    // post-filter is the only thing keeping `docs/superpowers/` (gitignored)
    // out of the result.
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    expect(await reader.scan({ pathPrefix: 'docs' })).toEqual([]);
    expect(await reader.scan({ pathPrefix: 'Projects' })).toEqual(['Projects/alpha.md']);
  });

  it('tag listings skip excluded notes (Templates, gitignored, config-excluded)', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const provider = new FsVaultProvider({ vaultRoot, reader });
    const tags = await provider.listTags();
    expect(tags.map((t) => t.name)).toEqual(['kept']);
  });

  it('property listings skip excluded notes: an excluded status property never surfaces', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const provider = new FsVaultProvider({ vaultRoot, reader });
    const properties = await provider.listProperties();
    // Templates/Daily.md (excluded by default scope) carries a `status`
    // property; it must contribute nothing to list_properties.
    expect(properties.map((p) => p.name)).not.toContain('status');
    // Only Projects/alpha.md is in scope, and its only frontmatter key is `tags`.
    expect(properties).toEqual([{ name: 'tags', count: 1 }]);
  });

  it('read_notes by explicit path bypasses scope (discovery, not access control)', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const [item] = await reader.readNotes({
      paths: ['Templates/Daily.md'],
      fields: ['content'],
    });
    expect(item).toMatchObject({
      path: 'Templates/Daily.md',
      content: expect.stringContaining('Template body'),
    });
  });
});
