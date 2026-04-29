import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSmartConnectionsCorpus } from '../../../src/lib/obsidian/smart-connections-loader.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import type {
  EmbeddingProvider,
  PathExistsCheck,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';

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

export function makeHandlerDeps(deps: {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists?: PathExistsCheck;
}) {
  return {
    ...deps,
    pathExists: deps.pathExists ?? (async () => true),
  };
}

export { loadSmartConnectionsCorpus, findNeighbors, findDuplicates, findBlockNeighbors };
export type { EmbeddingProvider, PathExistsCheck, SearchEngine, SmartSource };
