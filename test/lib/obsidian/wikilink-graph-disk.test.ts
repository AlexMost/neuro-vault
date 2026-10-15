import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

// A small vault laid out like a knowledge base whose notes live under one
// top-level folder (`Org/`) and link to each other with folder-relative paths
// (`[[Teams/_index]]`) and table-escaped aliases (`[[j-doe\|Jane Doe]]`).
const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'suffix-links-vault',
);

async function buildGraph(): Promise<WikilinkGraphIndex> {
  const graph = new WikilinkGraphIndex({ reader: new FsVaultReader({ vaultRoot: FIXTURE_ROOT }) });
  await graph.ensureFresh();
  return graph;
}

describe('WikilinkGraphIndex over the suffix-links fixture vault (disk)', () => {
  it('resolves folder-relative path links and table-escaped aliases on the team card', async () => {
    const graph = await buildGraph();

    expect(graph.getNoteLinks('Org/Teams/team-growth.md').outgoing).toEqual([
      { target: 'team-dev', resolved: true, path: 'Org/Teams/team-dev.md' },
      { target: 'Teams/_index', resolved: true, path: 'Org/Teams/_index.md' },
      { target: 'j-doe', resolved: true, path: 'Org/People/j-doe.md' },
      {
        target: 'Price-tracking',
        resolved: true,
        path: 'Org/Products/Missions/Price-tracking.md',
      },
      { target: 'Playbook/_index', resolved: false },
      { target: 'Ghost-mission', resolved: false },
    ]);
  });

  it('counts the backlinks those links create', async () => {
    const graph = await buildGraph();

    // `[[Teams/_index|…]]` from team-dev and team-growth.
    expect(graph.getBacklinkCount('Org/Teams/_index.md')).toBe(2);
    expect(graph.getNoteLinks('Org/Teams/_index.md').incoming).toEqual([
      { source: 'Org/Teams/team-dev.md' },
      { source: 'Org/Teams/team-growth.md' },
    ]);
    // `[[j-doe\|Jane Doe]]` from the people table.
    expect(graph.getBacklinkCount('Org/People/j-doe.md')).toBe(1);
    // `[[Teams/team-growth]]` from the person and the mission.
    expect(graph.getBacklinkCount('Org/Teams/team-growth.md')).toBe(3);
  });

  it('gives neither Playbook index a backlink while the suffix is ambiguous', async () => {
    const graph = await buildGraph();

    expect(graph.getBacklinkCount('Org/Playbook/_index.md')).toBe(0);
    expect(graph.getBacklinkCount('Legacy/Playbook/_index.md')).toBe(0);
  });
});
