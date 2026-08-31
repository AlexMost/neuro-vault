import { describe, expect, it } from 'vitest';

import { computeVaultOverview } from '../../../src/lib/obsidian/vault-overview.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeMockGraph, makeVault } from './_helpers.js';

const noConventions = async (): Promise<string | null> => null;

// The tags/properties sections of get_vault_overview are derived from the
// vault reader. Before the migration these went through the Obsidian CLI;
// these tests prove the overview is fully populated straight from disk with no
// CLI involved.
describe('disk → get_vault_overview (integration)', () => {
  it('populates top_tags and properties straight from disk', async () => {
    const root = await makeVault({ 'Tasks/a.md': '---\ntags: [alpha]\nstatus: todo\n---\n' });
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({
      reader,
      graph: makeMockGraph(),
      readConventions: noConventions,
    });

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
      graph: makeMockGraph(),
      readConventions: noConventions,
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
      graph: makeMockGraph(),
      readConventions: noConventions,
    });

    expect(overview.top_tags).toEqual([]);
    expect(overview.properties).toEqual([]);
  });

  it('top_tags includes inline-only tags from note bodies', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [fm]\n---\nbody #inlineonly\n',
      'b.md': 'plain body #inlineonly\n',
    });
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({
      reader,
      graph: makeMockGraph(),
      readConventions: noConventions,
    });

    expect(overview.top_tags).toEqual([
      { name: 'inlineonly', count: 2 },
      { name: 'fm', count: 1 },
    ]);
  });

  // Parity pin for the reader-derived overview. This literal was captured from
  // the provider-backed `computeVaultOverview` over this exact vault before the
  // aggregates moved off `VaultProvider`; the snapshot must stay identical,
  // field for field and order for order, because only the call site moved.
  it('returns the snapshot the provider-backed overview returned for the same vault', async () => {
    const root = await makeVault({
      'Projects/alpha.md': '---\ntags: [ai, mcp]\nstatus: todo\n---\nbody #inline\n',
      'Projects/beta.md': '---\ntags: ai\nstatus: done\npriority: 1\n---\n',
      'Notes/gamma.md': 'plain body #inline\n',
      'root.md': '---\ntags: []\n---\n',
    });
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({
      reader,
      graph: makeMockGraph(),
      readConventions: noConventions,
    });

    expect(overview).toEqual({
      total_notes: 4,
      folders: [
        { path: 'Projects', count: 2 },
        { path: '/', count: 1 },
        { path: 'Notes', count: 1 },
      ],
      top_tags: [
        { name: 'ai', count: 2 },
        { name: 'inline', count: 2 },
        { name: 'mcp', count: 1 },
      ],
      properties: [
        { name: 'tags', count: 3 },
        { name: 'status', count: 2 },
        { name: 'priority', count: 1 },
      ],
      top_by_backlinks: [
        { path: 'Notes/gamma.md', title: 'gamma', backlink_count: 0 },
        { path: 'Projects/alpha.md', title: 'alpha', backlink_count: 0 },
        { path: 'Projects/beta.md', title: 'beta', backlink_count: 0 },
        { path: 'root.md', title: 'root', backlink_count: 0 },
      ],
    });
  });
});
