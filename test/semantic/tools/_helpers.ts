import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { buildBasenameIndex, type BasenameIndex } from '../../../src/lib/obsidian/index.js';
import type {
  BackendStatus,
  CorpusSnapshot,
  SemanticBackend,
} from '../../../src/lib/obsidian/semantic-backend.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import {
  buildSearchNotesTool,
  type SearchNotesInput,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import type {
  EmbeddingProvider,
  ListMatchingPaths,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';
import { callTool } from '../../_gate.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';

export const MODEL_KEY = 'bge-micro-v2';

/** A minimal `SemanticBackend`-shaped corpus, snapshot-only. Tests build fakes against this. */
export interface CorpusLike {
  snapshot(): Promise<CorpusSnapshot>;
}

// Three fixed notes/blocks, one per fixture "name" — what the old Smart
// Connections `.ajson` fixtures (note-a/b/c) used to decode to. Kept as plain
// data now that nothing parses that format any more.
const ABC_SOURCES: Record<'note-a' | 'note-b' | 'note-c', [string, SmartSource]> = {
  'note-a': [
    'Folder/note-a.md',
    {
      path: 'Folder/note-a.md',
      embedding: [1, 0, 0],
      blocks: [
        {
          key: 'Folder/note-a.md#alpha concept',
          heading: '#alpha concept',
          lines: [1, 3],
          embedding: [],
        },
      ],
    },
  ],
  'note-b': [
    'Folder/note-b.md',
    {
      path: 'Folder/note-b.md',
      embedding: [0, 1, 0],
      blocks: [
        {
          key: 'Folder/note-b.md#beta concept',
          heading: '#beta concept',
          lines: [1, 3],
          embedding: [],
        },
      ],
    },
  ],
  'note-c': [
    'Folder/note-c.md',
    {
      path: 'Folder/note-c.md',
      embedding: [0, 0, 1],
      blocks: [
        {
          key: 'Folder/note-c.md#gamma concept',
          heading: '#gamma concept',
          lines: [1, 3],
          embedding: [],
        },
      ],
    },
  ],
};

/**
 * Build a temp vault root (empty on disk — nothing reads it directly) and a
 * `Map<string, SmartSource>` for the requested fixture names, e.g.
 * `['note-a.ajson', 'note-b.ajson']`. The `.ajson` suffix is accepted for
 * call-site continuity with the fixture names' original source format.
 */
export async function makeVaultFixture(
  fileNames: string[],
): Promise<{ tempRoot: string; sources: Map<string, SmartSource> }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-handlers-'));
  const sources = new Map(
    fileNames.map((fileName) => {
      const key = fileName.replace(/\.ajson$/, '') as keyof typeof ABC_SOURCES;
      const entry = ABC_SOURCES[key];
      if (!entry) throw new Error(`makeVaultFixture: unknown fixture "${fileName}"`);
      return entry;
    }),
  );
  return { tempRoot, sources };
}

export function createDuplicateCorpus(sources: Map<string, SmartSource>) {
  const merged = new Map(sources);

  merged.set('Folder/note-d.md', {
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

  merged.set('Folder/note-e.md', {
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

  return { sources: merged };
}

export function makeFakeGraph(counts: Record<string, number> = {}): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getBacklinkCount: vi.fn((p: string) => counts[p] ?? 0),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
  } as unknown as WikilinkGraphIndex;
}

export function makeFakeCorpusIndex(sources: Map<string, SmartSource>): CorpusLike {
  const basenameIndex = buildBasenameIndex(sources.keys());
  return {
    snapshot: vi.fn().mockResolvedValue({ sources, basenameIndex }),
  };
}

/**
 * Wrap a snapshot-only fake (`makeFakeCorpusIndex`, or any object with a
 * `snapshot()`) as a `SemanticBackend` for `entry.backend`. `snapshot` is the
 * same function reference as `corpus.snapshot` — a caller holding onto
 * `corpus` can still assert on its mock's call count via `backend.snapshot`.
 */
export function toBackend(
  corpus: Pick<CorpusLike, 'snapshot'>,
  status: BackendStatus = { state: 'ready' },
): SemanticBackend {
  return {
    snapshot: corpus.snapshot,
    status: () => status,
    dispose: async () => {},
  };
}

/**
 * Build a registry-backed SearchNotesDeps for search_notes tests.
 *
 * Creates a temporary vault directory on disk and populates it with empty
 * files for each path in `sources` (minus any listed in `absentPaths`), so
 * that `entry.filterExisting` keeps/drops them as the test expects.
 *
 * Returns the deps and a `cleanup` function that removes the temp directory.
 */
export async function makeSearchDeps(opts: {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  absentPaths?: Set<string>;
  corpus?: CorpusLike;
  graph?: WikilinkGraphIndex;
  listMatchingPaths?: ListMatchingPaths;
  backendStatus?: BackendStatus;
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
      backend: toBackend(corpus, opts.backendStatus),
      graph: opts.graph ?? makeFakeGraph(),
      listMatchingPaths: opts.listMatchingPaths ?? (async () => new Set()),
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

/**
 * Thin single-vault wrapper over `makeSearchDeps` for `semantic_status`
 * tests: build a synthetic corpus from `snapshotPaths` (default: one note),
 * a disk fixture where only `existingPaths` (default: all of them) actually
 * exist, wire `backendStatus` onto the vault's backend, and run
 * `search_notes` once with `input`. `allowed`, when given, becomes the
 * vault's `listMatchingPaths` result (for filter tests); `snapshot`, when
 * given, is used as the corpus's `snapshot` spy so a test can assert it was
 * (not) called. This helper's disk fixture always writes empty bodies (see
 * `makeSearchDeps`, which defaults to the registry's `emptyReader` — content
 * written to disk is invisible to the lexical leg regardless); a test that
 * needs a real lexical match should use `makeLexicalVault` from
 * `_hybrid-helpers.ts` instead, which wires a real `FsVaultReader`.
 */
export async function runSearch(opts: {
  backendStatus?: BackendStatus;
  input: SearchNotesInput;
  snapshotPaths?: string[];
  existingPaths?: string[];
  allowed?: Set<string>;
  snapshot?: ReturnType<typeof vi.fn>;
}): Promise<SearchNotesOutput> {
  const snapshotPaths = opts.snapshotPaths ?? ['Notes/a.md'];
  const sources = new Map(snapshotPaths.map((p) => [p, makeSyntheticSource(p)]));
  const basenameIndex = buildBasenameIndex(sources.keys());
  const snapshotFn = opts.snapshot ?? vi.fn();
  snapshotFn.mockResolvedValue({ sources, basenameIndex });

  const existingPaths = opts.existingPaths ?? snapshotPaths;
  const absentPaths = new Set(snapshotPaths.filter((p) => !existingPaths.includes(p)));

  const allowed = opts.allowed;
  const { deps, cleanup } = await makeSearchDeps({
    sources,
    embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0, 0]) },
    searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
    modelKey: MODEL_KEY,
    absentPaths,
    corpus: { snapshot: snapshotFn },
    backendStatus: opts.backendStatus,
    ...(allowed !== undefined ? { listMatchingPaths: async () => allowed } : {}),
  });

  try {
    const reg = registerTool(buildSearchNotesTool(deps));
    return await callTool<SearchNotesOutput>(reg, opts.input);
  } finally {
    await cleanup();
  }
}

export { makeTestRegistry };

export { findNeighbors, findDuplicates, findBlockNeighbors, buildBasenameIndex };
export type { EmbeddingProvider, ListMatchingPaths, SearchEngine, SmartSource, BasenameIndex };
