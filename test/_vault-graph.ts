import { vi } from 'vitest';

import type { IVaultGraph } from '../src/lib/obsidian/wikilink-graph.js';

/**
 * An in-memory {@link IVaultGraph} for tests: an empty graph — no links, no backlinks, no
 * target resolves — whose every method is a spy. Override the answers a test needs. A test
 * that wants the real graph over a reader builds a `WikilinkGraphIndex` instead.
 */
export function makeVaultGraph(overrides: Partial<IVaultGraph> = {}): IVaultGraph {
  return {
    ensureFresh: vi.fn(async () => {}),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
    resolve: vi.fn(() => null),
    ...overrides,
  };
}
