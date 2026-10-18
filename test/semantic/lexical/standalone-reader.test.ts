import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LexicalIndex } from '../../../src/lib/obsidian/lexical/index.js';
import { LexicalSearchError } from '../../../src/lib/obsidian/lexical/reader.js';
import { FsVaultReader, type VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { createStandaloneLexicalReader } from '../../../src/modules/semantic/lexical/index.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-lexical-'));
  await fs.writeFile(path.join(vaultRoot, 'alpha.md'), '# Alpha\n\nquirkyterm lives here\n');
  await fs.writeFile(path.join(vaultRoot, 'beta.md'), '# Beta\n\nquirkyterm too\n');
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

const SEARCH = { queries: ['quirkyterm'], noteCap: 10, perNoteCap: 3 };

function graphWith(
  counts: Record<string, number>,
  ensureFresh = vi.fn().mockResolvedValue(undefined),
) {
  return {
    ensureFresh,
    getBacklinkCount: vi.fn((p: string) => counts[p] ?? 0),
  };
}

describe('createStandaloneLexicalReader', () => {
  it('search equals LexicalIndex over the same files', async () => {
    const reader = new FsVaultReader({ vaultRoot });
    const counts = { 'beta.md': 4 };
    const graph = graphWith(counts);
    const expected = await new LexicalIndex({ vaultRoot, reader }).search({
      ...SEARCH,
      getBacklinkCount: (p) => counts[p as keyof typeof counts] ?? 0,
    });

    const actual = await createStandaloneLexicalReader({ vaultRoot, reader, graph }).search(SEARCH);

    expect(actual).toEqual(expected);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
    // The tie-break really came from the graph: beta has the backlinks, so it leads.
    expect(actual.notes.map((n) => n.path)[0]).toBe('beta.md');
  });

  it('warm resolves and parses nothing', async () => {
    const scan = vi.fn().mockResolvedValue([]);
    const reader: VaultReader = { scan, readNotes: vi.fn().mockResolvedValue([]) };
    const graph = graphWith({});

    await expect(
      createStandaloneLexicalReader({ vaultRoot, reader, graph }).warm(),
    ).resolves.toBeUndefined();

    expect(scan).not.toHaveBeenCalled();
    expect(graph.ensureFresh).not.toHaveBeenCalled();
  });

  it('a throwing index becomes LexicalSearchError', async () => {
    const boom = new Error('scan exploded');
    const reader: VaultReader = {
      scan: vi.fn().mockRejectedValue(boom),
      readNotes: vi.fn().mockResolvedValue([]),
    };

    const error = await createStandaloneLexicalReader({
      vaultRoot,
      reader,
      graph: graphWith({}),
    })
      .search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).cause).toBe(boom);
  });

  it('a throwing graph refresh becomes LexicalSearchError', async () => {
    const boom = new Error('graph exploded');
    const graph = graphWith({}, vi.fn().mockRejectedValue(boom));

    const error = await createStandaloneLexicalReader({
      vaultRoot,
      reader: new FsVaultReader({ vaultRoot }),
      graph,
    })
      .search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).cause).toBe(boom);
  });
});
