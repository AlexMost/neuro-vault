import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vi } from 'vitest';

import { buildBasenameIndex, type BasenameIndex } from '../../../src/lib/obsidian/index.js';
import type { SmartConnectionsCorpusIndex } from '../../../src/lib/obsidian/smart-connections-corpus-index.js';
import { loadSmartConnectionsCorpus } from '../../../src/lib/obsidian/smart-connections-loader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import type {
  EmbeddingProvider,
  ListMatchingPaths,
  PathExistsCheck,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(testDir, '../fixtures/vault/.smart-env/multi');

export const MODEL_KEY = 'bge-micro-v2';

export async function makeVaultFixture(fileNames: string[]) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-handlers-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

  await fs.mkdir(smartEnvPath, { recursive: true });

  for (const fileName of fileNames) {
    await fs.copyFile(path.join(fixturesRoot, fileName), path.join(smartEnvPath, fileName));
  }

  return { tempRoot, smartEnvPath };
}

export function createDuplicateCorpus(
  corpus: Awaited<ReturnType<typeof loadSmartConnectionsCorpus>>,
) {
  const sources = new Map(corpus.sources);

  sources.set('Folder/note-d.md', {
    path: 'Folder/note-d.md',
    embedding: [1, 0, 0],
    blocks: [
      {
        key: 'Folder/note-d.md#delta',
        heading: '#delta',
        lines: [1, 3] as [number, number],
        embedding: [],
      },
    ],
  });

  sources.set('Folder/note-e.md', {
    path: 'Folder/note-e.md',
    embedding: [1, 0, 0],
    blocks: [
      {
        key: 'Folder/note-e.md#echo',
        heading: '#echo',
        lines: [1, 3] as [number, number],
        embedding: [],
      },
    ],
  });

  return { sources };
}

export function makeFakeGraph(counts: Record<string, number> = {}): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getBacklinkCount: vi.fn((p: string) => counts[p] ?? 0),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
  } as unknown as WikilinkGraphIndex;
}

export function makeFakeCorpusIndex(
  sources: Map<string, SmartSource>,
): SmartConnectionsCorpusIndex {
  const basenameIndex = buildBasenameIndex(sources.keys());
  return {
    snapshot: vi.fn().mockResolvedValue({ sources, basenameIndex }),
  };
}

export function makeHandlerDeps(deps: {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists?: PathExistsCheck;
  corpus?: SmartConnectionsCorpusIndex;
  readNoteContent?: (vaultRelativePath: string) => Promise<string>;
  graph?: WikilinkGraphIndex;
  listMatchingPaths?: ListMatchingPaths;
}) {
  return {
    embeddingProvider: deps.embeddingProvider,
    searchEngine: deps.searchEngine,
    modelKey: deps.modelKey,
    pathExists: deps.pathExists ?? (async () => true),
    corpus: deps.corpus ?? makeFakeCorpusIndex(deps.sources),
    readNoteContent: deps.readNoteContent ?? (async () => ''),
    graph: deps.graph ?? makeFakeGraph(),
    listMatchingPaths: deps.listMatchingPaths ?? (async () => new Set()),
  };
}

/**
 * Build a registry-backed SearchNotesDeps for search_notes tests.
 *
 * Creates a temporary vault directory on disk and populates it with empty
 * files for each path in `sources` (minus any listed in `absentPaths`), so
 * that `pathExistsForEntry` returns true/false as the test expects.
 *
 * Returns the deps and a `cleanup` function that removes the temp directory.
 */
export async function makeSearchDeps(opts: {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  absentPaths?: Set<string>;
  corpus?: SmartConnectionsCorpusIndex;
  graph?: WikilinkGraphIndex;
  listMatchingPaths?: ListMatchingPaths;
}): Promise<{
  deps: {
    registry: ReturnType<typeof makeTestRegistry>;
    embeddingProvider: EmbeddingProvider;
    searchEngine: SearchEngine;
    modelKey: string;
  };
  cleanup: () => Promise<void>;
}> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'search-deps-'));
  const absent = opts.absentPaths ?? new Set<string>();

  for (const notePath of opts.sources.keys()) {
    if (absent.has(notePath)) continue;
    const full = path.join(vaultRoot, notePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '', 'utf8');
  }

  const corpus = opts.corpus ?? makeFakeCorpusIndex(opts.sources);
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      smartEnvPath: path.join(vaultRoot, '.smart-env'),
      corpus,
      graph: opts.graph ?? makeFakeGraph(),
      listMatchingPaths: opts.listMatchingPaths ?? (async () => new Set()),
      semanticAvailable: true,
    },
  ]);

  return {
    deps: {
      registry,
      embeddingProvider: opts.embeddingProvider,
      searchEngine: opts.searchEngine,
      modelKey: opts.modelKey,
    },
    cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }),
  };
}

export function makeSyntheticSource(
  notePath: string,
  embedding: number[] = [1, 0, 0],
): SmartSource {
  return {
    path: notePath,
    embedding,
    blocks: [],
  };
}

export { makeTestRegistry };

export {
  loadSmartConnectionsCorpus,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  buildBasenameIndex,
};
export type {
  EmbeddingProvider,
  ListMatchingPaths,
  PathExistsCheck,
  SearchEngine,
  SmartSource,
  BasenameIndex,
  SmartConnectionsCorpusIndex,
};
