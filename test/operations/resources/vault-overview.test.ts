import { describe, expect, it, vi } from 'vitest';

import { buildVaultOverviewResource } from '../../../src/modules/operations/resources/vault-overview.js';
import { buildOperationsResources } from '../../../src/modules/operations/resources/index.js';
import type { IVaultEntry } from '../../../src/lib/vault-registry.js';
import { makeGraph, makeProvider, makeReader } from '../tools/_helpers.js';
import { makeTestRegistry } from '../tools/_test-registry.js';

function makeEntry(overrides: Partial<IVaultEntry> = {}): IVaultEntry {
  return {
    name: 'v',
    path: '/v',
    smartEnvPath: '/v/.smart-env/multi',
    reader: makeReader(),
    provider: makeProvider(),
    graph: makeGraph(),
    listMatchingPaths: async () => new Set<string>(),
    semanticAvailable: true,
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
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
    });
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'x', count: 1 }]),
    });
    const graph = makeGraph();
    const res = buildVaultOverviewResource({
      uri: 'vault://overview',
      entry: makeEntry({ reader, provider, graph }),
    });

    const payload = await res.handler(new URL('vault://overview'));

    expect(payload.total_notes).toBe(1);
    expect(payload.top_tags).toEqual([{ name: 'x', count: 1 }]);
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
      makeEntry({ name: 'b', path: '/b', smartEnvPath: '/b/.smart-env/multi' }),
    ]);
    const resources = buildOperationsResources({ registry });
    expect(resources.map((r) => r.uri).sort()).toEqual([
      'vault://a/overview',
      'vault://b/overview',
    ]);
  });

  it('each resource handler returns the overview of its own vault — not the last one registered', async () => {
    const readerA = makeReader({ scan: vi.fn().mockResolvedValue(['A/note.md']) });
    const readerB = makeReader({
      scan: vi.fn().mockResolvedValue(['B/note1.md', 'B/note2.md']),
    });
    const providerA = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromA', count: 7 }]),
    });
    const providerB = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromB', count: 11 }]),
    });
    const registry = makeTestRegistry([
      makeEntry({ name: 'a', path: '/a', reader: readerA, provider: providerA }),
      makeEntry({ name: 'b', path: '/b', reader: readerB, provider: providerB }),
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

    expect(aPayload.total_notes).toBe(1);
    expect(bPayload.total_notes).toBe(2);
    expect(aPayload.top_tags).toEqual([{ name: 'fromA', count: 7 }]);
    expect(bPayload.top_tags).toEqual([{ name: 'fromB', count: 11 }]);

    // Also verify the providers were actually called per-vault — no shared deps.
    expect(providerA.listTags).toHaveBeenCalledTimes(1);
    expect(providerB.listTags).toHaveBeenCalledTimes(1);
  });
});
