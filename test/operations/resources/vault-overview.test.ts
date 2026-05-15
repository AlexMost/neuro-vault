import { describe, expect, it, vi } from 'vitest';

import { buildVaultOverviewResource } from '../../../src/modules/operations/resources/vault-overview.js';
import { buildOperationsResources } from '../../../src/modules/operations/resources/index.js';
import type { VaultEntry } from '../../../src/lib/vault-registry.js';
import { makeGraph, makeProvider, makeReader } from '../tools/_helpers.js';
import { makeTestRegistry } from '../tools/_test-registry.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
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
  } as VaultEntry;
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
});
