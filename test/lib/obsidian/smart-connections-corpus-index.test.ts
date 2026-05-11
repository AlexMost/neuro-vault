import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSmartConnectionsCorpusIndex } from '../../../src/lib/obsidian/smart-connections-corpus-index.js';
import type { LoadCorpusFn } from '../../../src/lib/obsidian/smart-connections-corpus-index.js';
import type { SmartConnectionsCorpus } from '../../../src/lib/obsidian/smart-connections-loader.js';
import type { SmartSource } from '../../../src/lib/obsidian/smart-connections-types.js';

const MODEL_KEY = 'bge-micro-v2';

function makeSource(p: string): SmartSource {
  return { path: p, embedding: [1, 0, 0], blocks: [] };
}

function makeCorpus(paths: string[]): SmartConnectionsCorpus {
  const sources = new Map<string, SmartSource>();
  for (const p of paths) sources.set(p, makeSource(p));
  return { sources };
}

async function makeSmartEnvDir(
  fileNames: string[],
): Promise<{ tempRoot: string; smartEnvPath: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'corpus-index-'));
  const smartEnvPath = path.join(tempRoot, '.smart-env', 'multi');
  await fs.mkdir(smartEnvPath, { recursive: true });
  for (const name of fileNames) {
    await fs.writeFile(path.join(smartEnvPath, name), '{}');
  }
  return { tempRoot, smartEnvPath };
}

describe('SmartConnectionsCorpusIndex', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function setup(fileNames: string[], initialPaths: string[]) {
    const { tempRoot, smartEnvPath } = await makeSmartEnvDir(fileNames);
    tempDirs.push(tempRoot);
    const loadCorpus = vi.fn().mockResolvedValue(makeCorpus(initialPaths));
    const index = await createSmartConnectionsCorpusIndex({
      smartEnvPath,
      modelKey: MODEL_KEY,
      loadCorpus,
    });
    return { index, loadCorpus, smartEnvPath };
  }

  it('loads the corpus once during construction', async () => {
    const { index, loadCorpus } = await setup(['a.ajson'], ['A.md']);

    expect(loadCorpus).toHaveBeenCalledTimes(1);
    expect([...index.getSources().keys()]).toEqual(['A.md']);
  });

  it('builds a basename index over the initial corpus', async () => {
    const { index } = await setup(['a.ajson'], ['Folder/A.md', 'Other/B.md']);

    expect(index.getBasenameIndex().resolve('A')).toBe('Folder/A.md');
    expect(index.getBasenameIndex().resolve('B')).toBe('Other/B.md');
  });

  it('does not reload when nothing on disk has changed', async () => {
    const { index, loadCorpus } = await setup(['a.ajson'], ['A.md']);
    loadCorpus.mockClear();

    await index.ensureFresh();
    await index.ensureFresh();

    expect(loadCorpus).not.toHaveBeenCalled();
  });

  it('reloads when an ajson file mtime advances', async () => {
    const { tempRoot, smartEnvPath } = await makeSmartEnvDir(['a.ajson']);
    tempDirs.push(tempRoot);

    const loadCorpus = vi
      .fn<LoadCorpusFn>()
      .mockResolvedValueOnce(makeCorpus(['A.md']))
      .mockResolvedValueOnce(makeCorpus(['A.md', 'B.md']));

    const index = await createSmartConnectionsCorpusIndex({
      smartEnvPath,
      modelKey: MODEL_KEY,
      loadCorpus,
    });

    // Bump mtime by re-touching the file with a future timestamp.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(smartEnvPath, 'a.ajson'), future, future);

    await index.ensureFresh();

    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect([...index.getSources().keys()].sort()).toEqual(['A.md', 'B.md']);
    expect(index.getBasenameIndex().resolve('B')).toBe('B.md');
  });
});
