import { describe, expect, it } from 'vitest';

import { computeVaultOverview } from '../../../src/lib/obsidian/vault-overview.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeMockGraph, makeProvider, makeVault } from './_helpers.js';

// FsVaultProvider feeds the tags/properties sections of get_vault_overview.
// Before the migration these went through the Obsidian CLI; these tests prove
// the overview is fully populated straight from disk with no CLI involved.
describe('FsVaultProvider → get_vault_overview (disk integration)', () => {
  it('populates top_tags and properties straight from disk', async () => {
    const root = await makeVault({ 'Tasks/a.md': '---\ntags: [alpha]\nstatus: todo\n---\n' });
    const reader = new FsVaultReader({ vaultRoot: root });
    const provider = makeProvider(root);

    const overview = await computeVaultOverview({ reader, provider, graph: makeMockGraph() });

    expect(overview.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
    expect(overview.properties).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
    ]);
  });

  it('aggregates tags and properties across multiple notes', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha, beta]\nstatus: todo\n---\n',
      'b.md': '---\ntags: alpha\nstatus: done\npriority: 1\n---\n',
    });
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({
      reader,
      provider: makeProvider(root),
      graph: makeMockGraph(),
    });

    expect(overview.top_tags).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 1 },
    ]);
    // count desc, then name asc
    expect(overview.properties).toEqual([
      { name: 'status', count: 2 },
      { name: 'tags', count: 2 },
      { name: 'priority', count: 1 },
    ]);
  });

  it('yields empty tag/property sections for a vault with no frontmatter', async () => {
    const root = await makeVault({ 'a.md': 'plain body\n', 'b.md': '# heading\n' });
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({
      reader,
      provider: makeProvider(root),
      graph: makeMockGraph(),
    });

    expect(overview.top_tags).toEqual([]);
    expect(overview.properties).toEqual([]);
  });
});
