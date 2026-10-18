import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LexicalIndex } from '../../../../src/lib/obsidian/lexical/lexical-index.js';
import { FsVaultReader } from '../../../../src/lib/obsidian/vault-reader.js';
import { LegacyLexicalIndex } from './_legacy-lexical-index.js';
import { FIXTURE_PATHS, QUERY_SETS, writeFixtureVault } from './_fixture-vault.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-parity-'));
  await writeFixtureVault(vaultRoot);
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

const backlinks: Record<string, number> = {
  'Гібридний пошук.md': 4,
  'Tasks/Release plan.md': 2,
  'Ideas/Semantic ideas.md': 1,
};
const getBacklinkCount = (p: string): number => backlinks[p] ?? 0;

describe('LexicalIndex parity with the frozen oracle', () => {
  const filters: Array<[string, Set<string> | undefined]> = [
    ['no filter', undefined],
    ['5 allowed paths', new Set(FIXTURE_PATHS.slice(0, 5))],
  ];

  for (const [label, allowed] of filters) {
    for (const queries of QUERY_SETS) {
      it(`${label}: ${JSON.stringify(queries)}`, async () => {
        const reader = new FsVaultReader({ vaultRoot });
        const opts = {
          queries,
          ...(allowed ? { allowed } : {}),
          noteCap: 10,
          perNoteCap: 3,
          getBacklinkCount,
        };
        const next = await new LexicalIndex({ vaultRoot, reader }).search(opts);
        const legacy = await new LegacyLexicalIndex({ vaultRoot, reader }).search(opts);
        expect(next).toEqual(legacy);
      });
    }
  }

  it('every set except no-match returns notes (the sets exercise their case)', async () => {
    const reader = new FsVaultReader({ vaultRoot });
    const idx = new LexicalIndex({ vaultRoot, reader });
    for (const queries of QUERY_SETS) {
      const { notes } = await idx.search({ queries, noteCap: 10, perNoteCap: 3, getBacklinkCount });
      if (queries[0] === 'цього тут немає ніде') expect(notes).toHaveLength(0);
      else expect(notes.length, JSON.stringify(queries)).toBeGreaterThan(0);
    }
  });
});
