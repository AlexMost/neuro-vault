import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { createStandaloneLexicalReader } from '../../../src/modules/semantic/lexical/index.js';
import type { BackendStatus } from '../../../src/lib/obsidian/semantic-backend.js';
import type { ListMatchingPaths, SmartSource } from '../../../src/modules/semantic/types.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { makeTestRegistry, makeFakeGraph, makeFakeCorpusIndex, toBackend } from './_helpers.js';

// Shared fixtures for the hybrid search_notes tests (mode/effort axes,
// lexical+semantic orchestration, and the end-to-end sanity fixture). Lives
// in its own (non-`.test.ts`) module so both test files can import it without
// re-executing another file's top-level `describe`/`it` registrations.

export function sourcesWithEmbeddingFor(
  notePath: string,
  embedding: number[] = [1, 0],
): Map<string, SmartSource> {
  return new Map([
    [notePath, { path: notePath, embedding: Float32Array.from(embedding), blocks: [] }],
  ]);
}

/**
 * The 2-D unit vector whose cosine with the default query vector `[1, 0]` is
 * `similarity` (up to float32 rounding — compare with `toBeCloseTo`).
 */
export function vectorScoring(similarity: number): number[] {
  return [similarity, Math.sqrt(1 - similarity * similarity)];
}

/** Notes the semantic leg ranks at these similarities for the default query vector. */
export function sourcesScoring(
  hits: Array<{ path: string; similarity: number }>,
): Map<string, SmartSource> {
  return new Map(
    hits.map(({ path: notePath, similarity }) => [
      notePath,
      { path: notePath, embedding: Float32Array.from(vectorScoring(similarity)), blocks: [] },
    ]),
  );
}

export async function makeLexicalVault(
  files: Record<string, string>,
  opts: {
    semantic?: boolean;
    sources?: Map<string, SmartSource>;
    listMatchingPaths?: ListMatchingPaths;
    backendStatus?: BackendStatus;
  } = {},
) {
  const semantic = opts.semantic ?? true;
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(vaultRoot, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  const reader = new FsVaultReader({ vaultRoot });
  const graph = makeFakeGraph();
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      reader,
      backend: semantic
        ? toBackend(makeFakeCorpusIndex(opts.sources ?? new Map()), opts.backendStatus)
        : undefined,
      graph,
      lexical: createStandaloneLexicalReader({ vaultRoot, reader, graph }),
      listMatchingPaths: opts.listMatchingPaths ?? (async () => new Set(Object.keys(files))),
    },
  ]);
  const deps = {
    registry,
    embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
    modelKey: 'k',
    similarity: TEST_SIMILARITY,
  };
  return { deps, cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }) };
}
