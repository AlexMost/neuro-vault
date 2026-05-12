import { describe, expect, it, vi } from 'vitest';

import { buildVaultOverviewResource } from '../../../src/modules/operations/resources/vault-overview.js';
import { makeGraph, makeProvider, makeReader } from '../tools/_helpers.js';

describe('operations.vaultOverview resource', () => {
  it('declares name, uri, and json mimeType', () => {
    const res = buildVaultOverviewResource({
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
    });
    expect(res.name).toBe('vault-overview');
    expect(res.uri).toBe('vault://overview');
    expect(res.mimeType).toBe('application/json');
    expect(res.title).toBe('Vault Overview');
  });

  it('returns the same snapshot as computeVaultOverview, JSON-encoded', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
    });
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'x', count: 1 }]),
    });
    const graph = makeGraph();
    const res = buildVaultOverviewResource({ reader, provider, graph });

    const payload = await res.handler(new URL('vault://overview'));

    expect(payload.total_notes).toBe(1);
    expect(payload.top_tags).toEqual([{ name: 'x', count: 1 }]);
  });
});
