import { vi } from 'vitest';

import {
  createGraphReader,
  GraphReadError,
  type IGraphReader,
} from '../src/lib/obsidian/graph-reader.js';
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

/**
 * {@link makeVaultGraph} whose `read` fails as a view's does when the daemon cannot answer:
 * with a {@link GraphReadError} carrying `message`.
 */
export function failingGraph(
  read: keyof IGraphReader,
  message = 'daemon did not answer graph read in time',
): IGraphReader {
  return makeVaultGraph({
    [read]: vi.fn(async () => {
      throw new GraphReadError(message);
    }),
  });
}

/** The reader over a real `WikilinkGraphIndex` on `reader`, as a `--no-semantic` session builds. */
export function graphReaderOver(reader: VaultReader): IGraphReader {
  const graph: IVaultGraph = new WikilinkGraphIndex({ reader });
  return createGraphReader(() => graph);
}

/** The error envelope a tool answers with when its graph read fails (`graphForTool`). */
export function graphReadFailure(vault: string, operation: string) {
  return {
    code: 'DEPENDENCY_ERROR',
    message: 'Graph read failed',
    details: { vault, operation },
  };
}
