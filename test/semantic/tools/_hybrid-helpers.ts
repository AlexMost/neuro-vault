import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type {
  ListMatchingPaths,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';
import { makeTestRegistry, makeFakeGraph, makeFakeCorpusIndex } from './_helpers.js';

// Shared fixtures for the hybrid search_notes tests (mode/effort axes,
// lexical+semantic orchestration, and the end-to-end sanity fixture). Lives
// in its own (non-`.test.ts`) module so both test files can import it without
// re-executing another file's top-level `describe`/`it` registrations.

// No explicit `SearchEngine` return-type annotation: callers that mutate the
// mock after creation (e.g. `engine.findNeighbors.mockReturnValue(...)`) rely
// on the inferred vi.Mock type, not the widened interface type.
export function makeMockEngine() {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

export async function makeLexicalVault(
  files: Record<string, string>,
  opts: {
    semantic?: boolean;
    sources?: Map<string, SmartSource>;
    engine?: SearchEngine;
    listMatchingPaths?: ListMatchingPaths;
  } = {},
) {
  const semantic = opts.semantic ?? true;
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(vaultRoot, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      smartEnvPath: path.join(vaultRoot, '.smart-env'),
      reader: new FsVaultReader({ vaultRoot }),
      corpus: semantic ? makeFakeCorpusIndex(opts.sources ?? new Map()) : undefined,
      graph: makeFakeGraph(),
      listMatchingPaths: opts.listMatchingPaths ?? (async () => new Set(Object.keys(files))),
      semanticAvailable: semantic,
    },
  ]);
  const deps = {
    registry,
    embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
    searchEngine: opts.engine ?? makeMockEngine(),
    modelKey: 'k',
  };
  return { deps, cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }) };
}
