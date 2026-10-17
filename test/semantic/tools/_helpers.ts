import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import type { ICorpusReader } from '../../../src/lib/obsidian/corpus/corpus.js';
import { buildBasenameIndex, type BasenameIndex } from '../../../src/lib/obsidian/index.js';
import type {
  BackendStatus,
  ISemanticBackend,
} from '../../../src/lib/obsidian/semantic-backend.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import {
  buildSearchNotesTool,
  type SearchNotesInput,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import type {
  QueryEmbedder,
  ListMatchingPaths,
  SmartSource,
} from '../../../src/modules/semantic/types.js';
import { callTool } from '../../_gate.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { corpusOver } from '../../_memory-corpus.js';
import type { SimilarityDefaults } from '../../../src/lib/model-profiles.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';

export const MODEL_KEY = 'bge-micro-v2';

/** A corpus whose two reads are spies, so a test can assert on what reached the corpus. */
export interface CorpusLike extends ICorpusReader {
  nearest: ReturnType<typeof vi.fn<ICorpusReader['nearest']>>;
  nearestBlocks: ReturnType<typeof vi.fn<ICorpusReader['nearestBlocks']>>;
}

// Three fixed notes/blocks, one per fixture "name" — what the old Smart
// Connections `.ajson` fixtures (note-a/b/c) used to decode to. Kept as plain
// data now that nothing parses that format any more.
const ABC_SOURCES: Record<'note-a' | 'note-b' | 'note-c', [string, SmartSource]> = {
  'note-a': [
    'Folder/note-a.md',
    {
      path: 'Folder/note-a.md',
      embedding: new Float32Array([1, 0, 0]),
      blocks: [
        {
          key: 'Folder/note-a.md#alpha concept',
          heading: '#alpha concept',
          lines: [1, 3],
          embedding: new Float32Array([]),
        },
      ],
    },
  ],
  'note-b': [
    'Folder/note-b.md',
    {
      path: 'Folder/note-b.md',
      embedding: new Float32Array([0, 1, 0]),
      blocks: [
        {
          key: 'Folder/note-b.md#beta concept',
          heading: '#beta concept',
          lines: [1, 3],
          embedding: new Float32Array([]),
        },
      ],
    },
  ],
  'note-c': [
    'Folder/note-c.md',
    {
      path: 'Folder/note-c.md',
      embedding: new Float32Array([0, 0, 1]),
      blocks: [
        {
          key: 'Folder/note-c.md#gamma concept',
          heading: '#gamma concept',
          lines: [1, 3],
          embedding: new Float32Array([]),
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
    embedding: new Float32Array([1, 0, 0]),
    blocks: [
      {
        key: 'Folder/note-d.md#delta',
        heading: '#delta',
        lines: [1, 3] as [number, number],
        embedding: new Float32Array([]),
      },
    ],
  });

  merged.set('Folder/note-e.md', {
    path: 'Folder/note-e.md',
    embedding: new Float32Array([1, 0, 0]),
    blocks: [
      {
        key: 'Folder/note-e.md#echo',
        heading: '#echo',
        lines: [1, 3] as [number, number],
        embedding: new Float32Array([]),
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

/**
 * A reader whose scoped note list is exactly the corpus' paths: what `entry.reader.scan()`
 * returns for a vault whose every note carries a record (a short note is a path in the scan
 * with an empty vector in `sources`).
 */
export function readerOf(sources: Map<string, SmartSource>): VaultReader {
  return {
    scan: async () => [...sources.keys()].sort(),
    readNotes: async () => [],
  };
}

/** The real corpus ranking over `sources`, behind spies. */
export function makeFakeCorpusIndex(sources: Map<string, SmartSource>): CorpusLike {
  const corpus = corpusOver(sources);
  return {
    nearest: vi.fn<ICorpusReader['nearest']>((anchors, opts) => corpus.nearest(anchors, opts)),
    nearestBlocks: vi.fn<ICorpusReader['nearestBlocks']>((anchors, opts) =>
      corpus.nearestBlocks(anchors, opts),
    ),
  };
}

/**
 * Wrap a corpus (`makeFakeCorpusIndex`, or any `ICorpusReader`) as an
 * `ISemanticBackend` for `entry.backend`, parked in `status`. The reads are the
 * corpus's own function references, so a caller holding onto the corpus can
 * still assert on its spies.
 */
export function toBackend(
  corpus: ICorpusReader,
  status: BackendStatus = { state: 'ready' },
): ISemanticBackend & { status: ReturnType<typeof vi.fn<ISemanticBackend['status']>> } {
  return {
    nearest: corpus.nearest,
    nearestBlocks: corpus.nearestBlocks,
    status: vi.fn<ISemanticBackend['status']>(async () => status),
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
  embeddingProvider: QueryEmbedder;
  modelKey: string;
  similarity?: SimilarityDefaults;
  absentPaths?: Set<string>;
  corpus?: ICorpusReader;
  graph?: WikilinkGraphIndex;
  listMatchingPaths?: ListMatchingPaths;
  backendStatus?: BackendStatus;
}): Promise<{
  deps: {
    registry: ReturnType<typeof makeTestRegistry>;
    embeddingProvider: QueryEmbedder;
    modelKey: string;
    similarity: SimilarityDefaults;
  };
  backend: ReturnType<typeof toBackend>;
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
  const backend = toBackend(corpus, opts.backendStatus);
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      backend,
      graph: opts.graph ?? makeFakeGraph(),
      listMatchingPaths: opts.listMatchingPaths ?? (async () => new Set()),
    },
  ]);

  return {
    deps: {
      registry,
      embeddingProvider: opts.embeddingProvider,
      modelKey: opts.modelKey,
      similarity: opts.similarity ?? TEST_SIMILARITY,
    },
    backend,
    cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }),
  };
}

export function makeSyntheticSource(
  notePath: string,
  embedding: number[] = [1, 0, 0],
): SmartSource {
  return {
    path: notePath,
    embedding: Float32Array.from(embedding),
    blocks: [],
  };
}

/**
 * Thin single-vault wrapper over `makeSearchDeps` for `semantic_status`
 * tests: build a synthetic corpus from `corpusPaths` (default: one note),
 * a disk fixture where only `existingPaths` (default: all of them) actually
 * exist, wire `backendStatus` onto the vault's backend, and run
 * `search_notes` once with `input`. `allowed`, when given, becomes the
 * vault's `listMatchingPaths` result (for filter tests); `corpus`, when
 * given, replaces the synthetic corpus so a test can assert on its spies
 * (see `makeFakeCorpusIndex`). This helper's disk fixture always writes empty bodies (see
 * `makeSearchDeps`, which defaults to the registry's `emptyReader` — content
 * written to disk is invisible to the lexical leg regardless); a test that
 * needs a real lexical match should use `makeLexicalVault` from
 * `_hybrid-helpers.ts` instead, which wires a real `FsVaultReader`.
 */
export async function runSearch(opts: {
  backendStatus?: BackendStatus;
  input: SearchNotesInput;
  corpusPaths?: string[];
  existingPaths?: string[];
  allowed?: Set<string>;
  corpus?: ICorpusReader;
}): Promise<SearchNotesOutput> {
  const corpusPaths = opts.corpusPaths ?? ['Notes/a.md'];
  const sources = new Map(corpusPaths.map((p) => [p, makeSyntheticSource(p)]));

  const existingPaths = opts.existingPaths ?? corpusPaths;
  const absentPaths = new Set(corpusPaths.filter((p) => !existingPaths.includes(p)));

  const allowed = opts.allowed;
  const { deps, cleanup } = await makeSearchDeps({
    sources,
    embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0, 0]) },
    modelKey: MODEL_KEY,
    absentPaths,
    ...(opts.corpus !== undefined ? { corpus: opts.corpus } : {}),
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

export { buildBasenameIndex };
export type { QueryEmbedder, ListMatchingPaths, SmartSource, BasenameIndex };
