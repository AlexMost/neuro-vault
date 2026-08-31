import { describe, expect, it } from 'vitest';

import { buildVaultOverviewResource } from '../../../src/modules/operations/resources/vault-overview.js';
import { buildOperationsResources } from '../../../src/modules/operations/resources/index.js';
import type { IVaultEntry } from '../../../src/lib/vault-registry.js';
import { makeGraph, makeReader, readerOver } from '../tools/_helpers.js';
import { makeTestRegistry } from '../tools/_test-registry.js';

function makeEntry(overrides: Partial<IVaultEntry> = {}): IVaultEntry {
  return {
    name: 'v',
    path: '/v',
    reader: makeReader(),
    graph: makeGraph(),
    listMatchingPaths: async () => new Set<string>(),
    readConventions: async () => null,
    ...overrides,
  } as IVaultEntry;
}

describe('operations.vaultOverview resource', () => {
  it('declares name, uri, and json mimeType (single-vault)', () => {
    const res = buildVaultOverviewResource({ uri: 'vault://overview', entry: makeEntry() });
    expect(res.name).toBe('vault-overview');
    expect(res.uri).toBe('vault://overview');
    expect(res.mimeType).toBe('application/json');
    expect(res.title).toBe('Vault Overview');
  });

  it('declares per-vault uri/name/title when given a namespaced uri', () => {
    const res = buildVaultOverviewResource({
      uri: 'vault://dmarkoff/overview',
      entry: makeEntry({ name: 'dmarkoff' }),
    });
    expect(res.uri).toBe('vault://dmarkoff/overview');
    expect(res.name).toBe('vault-overview-dmarkoff');
    expect(res.title).toBe('Vault Overview — dmarkoff');
  });

  it('returns the same snapshot as computeVaultOverview, JSON-encoded', async () => {
    const reader = readerOver({ 'Notes/a.md': { frontmatter: { tags: ['x'] } } });
    const graph = makeGraph();
    const res = buildVaultOverviewResource({
      uri: 'vault://overview',
      entry: makeEntry({ reader, graph }),
    });

    const payload = await res.handler(new URL('vault://overview'));

    expect(payload.total_notes).toBe(1);
    expect(payload.top_tags).toEqual([{ name: 'x', count: 1 }]);
  });

  it('carries the same conventions field as the tool', async () => {
    const res = buildVaultOverviewResource({
      uri: 'vault://overview',
      entry: makeEntry({ readConventions: async () => '# House rules' }),
    });
    const payload = await res.handler(new URL('vault://overview'));
    expect(payload.conventions).toBe('# House rules');
  });
});

describe('buildOperationsResources', () => {
  it('single-vault registry emits one vault://overview resource', () => {
    const registry = makeTestRegistry([makeEntry({ name: 'only' })]);
    const resources = buildOperationsResources({ registry });
    expect(resources.map((r) => r.uri)).toEqual(['vault://overview']);
  });

  it('multi-vault registry emits one namespaced resource per vault', () => {
    const registry = makeTestRegistry([
      makeEntry({ name: 'a' }),
      makeEntry({ name: 'b', path: '/b' }),
    ]);
    const resources = buildOperationsResources({ registry });
    expect(resources.map((r) => r.uri).sort()).toEqual([
      'vault://a/overview',
      'vault://b/overview',
    ]);
  });

  it('each resource handler returns the overview of its own vault — not the last one registered', async () => {
    const aTagged = { frontmatter: { tags: ['fromA'] } };
    const bTagged = { frontmatter: { tags: ['fromB'] } };
    const readerA = readerOver(
      Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`A/note${i}.md`, aTagged])),
    );
    const readerB = readerOver(
      Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`B/note${i}.md`, bTagged])),
    );
    const registry = makeTestRegistry([
      makeEntry({ name: 'a', path: '/a', reader: readerA }),
      makeEntry({ name: 'b', path: '/b', reader: readerB }),
    ]);

    const resources = buildOperationsResources({ registry });
    const byUri = new Map(resources.map((r) => [r.uri, r]));

    const aResp = await byUri
      .get('vault://a/overview')!
      .handler(new URL('vault://a/overview'), {} as never);
    const bResp = await byUri
      .get('vault://b/overview')!
      .handler(new URL('vault://b/overview'), {} as never);

    expect(aResp.contents[0].uri).toBe('vault://a/overview');
    expect(bResp.contents[0].uri).toBe('vault://b/overview');

    const aPayload = JSON.parse((aResp.contents[0] as { text: string }).text);
    const bPayload = JSON.parse((bResp.contents[0] as { text: string }).text);

    expect(aPayload.total_notes).toBe(7);
    expect(bPayload.total_notes).toBe(11);
    expect(aPayload.top_tags).toEqual([{ name: 'fromA', count: 7 }]);
    expect(bPayload.top_tags).toEqual([{ name: 'fromB', count: 11 }]);

    // Also verify each vault's own reader was actually used — no shared deps.
    expect(readerA.readNotes).toHaveBeenCalled();
    expect(readerB.readNotes).toHaveBeenCalled();
  });
});
