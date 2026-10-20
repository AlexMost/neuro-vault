import { vi } from 'vitest';

import { createGraphReader, type IGraphReader } from '../src/lib/obsidian/graph-reader.js';
import type { VaultReader } from '../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex, type IVaultGraph } from '../src/lib/obsidian/wikilink-graph.js';

/**
 * An in-memory {@link IGraphReader} for tests: an empty graph — no links, no backlinks, no
 * target resolves — whose every read is a spy. Override the answers a test needs, or build one
 * over a real graph with {@link graphReaderOver}.
 */
export function makeVaultGraph(overrides: Partial<IGraphReader> = {}): IGraphReader {
  return {
    noteLinks: vi.fn(async () => ({ incoming: [], outgoing: [] })),
    backlinkCounts: vi.fn(async (paths: readonly string[]) => paths.map(() => 0)),
    resolve: vi.fn(async (targets: readonly string[]) => targets.map(() => null)),
    ...overrides,
  };
}

/** {@link makeVaultGraph} whose backlink counts are `counts` (0 for any other path). */
export function graphWithBacklinks(counts: Record<string, number>): IGraphReader {
  return makeVaultGraph({
    backlinkCounts: vi.fn(async (paths: readonly string[]) => paths.map((p) => counts[p] ?? 0)),
  });
}

/** The reader over a real `WikilinkGraphIndex` on `reader`, as a `--no-semantic` session builds. */
export function graphReaderOver(reader: VaultReader): IGraphReader {
  const graph: IVaultGraph = new WikilinkGraphIndex({ reader });
  return createGraphReader(() => graph);
}
