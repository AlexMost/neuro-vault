import fs from 'node:fs/promises';
import os from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  buildFindDuplicatesTool,
  DUPLICATE_ANCHOR_BATCH,
} from '../../../src/modules/semantic/tools/find-duplicates.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeCorpusIndex,
  createDuplicateCorpus,
  makeSyntheticSource,
  readerOf,
  toBackend,
} from './_helpers.js';
import type { SmartSource } from './_helpers.js';
import { legacyFindDuplicates } from '../_legacy-retrieval.js';
import { CorpusNotReadyError } from '../../../src/lib/obsidian/semantic-backend.js';

type DuplicateResults = Awaited<ReturnType<ReturnType<typeof buildFindDuplicatesTool>['handler']>>;

describe('findDuplicates', () => {
  it('drops duplicate pairs whose paths no longer exist on disk', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      // Use real tempRoot so entry.filterExisting checks an actual directory.
      // None of the fixture's note paths (nor the synthetic note-d/note-e)
      // exist on disk in tempRoot, so every pair is filtered out — this test
      // validates the filtering mechanism, not the ranking.
      const duplicateSources = createDuplicateCorpus(sources).sources;
      const corpusIndex = makeFakeCorpusIndex(duplicateSources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          backend: toBackend(corpusIndex),
          reader: readerOf(duplicateSources),
        },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      const results = await callTool<DuplicateResults>(reg, { threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops duplicate pairs whose paths no longer exist on disk (partially populated vault)', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const duplicateSources = createDuplicateCorpus(sources).sources;
      // Create a corpus that returns all sources including synthetic note-d/note-e
      const corpusIndex = makeFakeCorpusIndex(duplicateSources);

      // Create actual vault directory with only specific notes present
      const vaultRoot = await fs.mkdtemp(`${os.tmpdir()}/find-dup-`);
      await fs.mkdir(`${vaultRoot}/Folder`, { recursive: true });
      // Create note-a and note-e (but not note-d) so the pair (a,d) is dropped
      await fs.writeFile(`${vaultRoot}/Folder/note-a.md`, '# A\n');
      await fs.writeFile(`${vaultRoot}/Folder/note-e.md`, '# E\n');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            backend: toBackend(corpusIndex),
            reader: readerOf(duplicateSources),
          },
        ]);
        const tool = buildFindDuplicatesTool({
          registry,
          modelKey: 'bge-micro-v2',
          similarity: TEST_SIMILARITY,
        });
        const reg = registerTool(tool);

        const results = await callTool<DuplicateResults>(reg, { threshold: 0.95 });

        // note-d doesn't exist on disk; pairs involving note-d are dropped.
        // note-a and note-e both exist, so (a,e) stays; note-b and note-c
        // (the fixture's real notes) don't exist in vaultRoot either.
        expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
          ['Folder/note-a.md', 'Folder/note-e.md'],
        ]);
        expect(results.every((r) => r.vault === 'v')).toBe(true);
      } finally {
        await fs.rm(vaultRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns matching duplicate pairs with vault stamp', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const duplicateSources = createDuplicateCorpus(sources).sources;

      // Create vault with all required notes so nothing is filtered
      const vaultRoot = await fs.mkdtemp(`${os.tmpdir()}/find-dup2-`);
      await fs.mkdir(`${vaultRoot}/Folder`, { recursive: true });
      for (const name of ['note-a.md', 'note-b.md', 'note-c.md', 'note-d.md', 'note-e.md']) {
        await fs.writeFile(`${vaultRoot}/Folder/${name}`, `# ${name}\n`);
      }

      try {
        const corpusIndex = makeFakeCorpusIndex(duplicateSources);
        const registry = makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            backend: toBackend(corpusIndex),
            reader: readerOf(duplicateSources),
          },
        ]);
        const tool = buildFindDuplicatesTool({
          registry,
          modelKey: 'bge-micro-v2',
          similarity: TEST_SIMILARITY,
        });
        const reg = registerTool(tool);

        const results = await callTool<DuplicateResults>(reg, { threshold: 0.95 });

        expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
          ['Folder/note-a.md', 'Folder/note-d.md'],
          ['Folder/note-a.md', 'Folder/note-e.md'],
          ['Folder/note-d.md', 'Folder/note-e.md'],
        ]);
        expect(results.every((result) => result.similarity >= 0.95)).toBe(true);
        expect(results.every((result) => result.vault === 'v')).toBe(true);
      } finally {
        await fs.rm(vaultRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws VAULT_REQUIRED in multi-vault mode when vault: is omitted', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        { name: 'v1', path: tempRoot, backend: toBackend(corpusIndex) },
        { name: 'v2', path: tempRoot, backend: toBackend(corpusIndex) },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, {})).rejects.toMatchObject({ code: 'VAULT_REQUIRED' });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws SEMANTIC_INDEX_NOT_FOUND when vault has no semantic backend', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
        },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, {})).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('a read the corpus refuses as not ready is reported as the readiness gate would', async () => {
    const sources = new Map([['a.md', makeSyntheticSource('a.md', [1, 0, 0])]]);
    const corpus = makeFakeCorpusIndex(sources);
    corpus.nearest.mockRejectedValue(new CorpusNotReadyError({ state: 'disabled' }));
    const registry = makeTestRegistry([
      { name: 'v', path: '/nonexistent', backend: toBackend(corpus), reader: readerOf(sources) },
    ]);
    const reg = registerTool(
      buildFindDuplicatesTool({ registry, modelKey: MODEL_KEY, similarity: TEST_SIMILARITY }),
    );

    await expect(callTool(reg, {})).rejects.toMatchObject({ code: 'SEMANTIC_DISABLED' });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([{ name: 'v', path: tempRoot }]);
      const tool = buildFindDuplicatesTool({
        registry,
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { vault: 'v' })).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
  it('honours a substituted existence filter with no files on disk', async () => {
    const pairSources = new Map([
      [
        'Folder/note-d.md',
        { path: 'Folder/note-d.md', embedding: new Float32Array([1, 0, 0]), blocks: [] },
      ],
      [
        'Folder/note-e.md',
        { path: 'Folder/note-e.md', embedding: new Float32Array([1, 0, 0]), blocks: [] },
      ],
    ]);
    const corpus = makeFakeCorpusIndex(pairSources);
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: '/nonexistent',
        backend: toBackend(corpus),
        reader: readerOf(pairSources),
        // Everything the corpus names is declared present — no temp dir.
        filterExisting: async (paths) => new Set(paths),
      },
    ]);
    const tool = buildFindDuplicatesTool({
      registry,
      modelKey: MODEL_KEY,
      similarity: TEST_SIMILARITY,
    });
    const reg = registerTool(tool);

    const results = await callTool<DuplicateResults>(reg, { threshold: 0.95 });

    expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
      ['Folder/note-d.md', 'Folder/note-e.md'],
    ]);
  });

  it('applies the profile’s duplicates default when threshold is omitted', async () => {
    // Similarity to x: y 0.98, z 0.96 — only the former clears the profile's 0.97.
    const sources = new Map<string, SmartSource>([
      ['x.md', makeSyntheticSource('x.md', [1, 0])],
      ['y.md', makeSyntheticSource('y.md', [0.98, Math.sqrt(1 - 0.98 ** 2)])],
      ['z.md', makeSyntheticSource('z.md', [0.96, -Math.sqrt(1 - 0.96 ** 2)])],
    ]);
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: os.tmpdir(),
        backend: toBackend(makeFakeCorpusIndex(sources)),
        reader: readerOf(sources),
        filterExisting: async (paths) => new Set(paths),
      },
    ]);
    const tool = buildFindDuplicatesTool({
      registry,
      modelKey: MODEL_KEY,
      similarity: { ...TEST_SIMILARITY, duplicates: 0.97 },
    });
    const results = await callTool<DuplicateResults>(registerTool(tool), {});
    expect(results.map((r) => [r.note_a, r.note_b])).toEqual([['x.md', 'y.md']]);
  });

  describe('over the corpus reads', () => {
    function vaultOf(sources: Map<string, SmartSource>, corpus = makeFakeCorpusIndex(sources)) {
      return makeTestRegistry([
        {
          name: 'v',
          path: '/nonexistent',
          backend: toBackend(corpus),
          reader: readerOf(sources),
          // Every path the corpus names is declared present — no temp dir.
          filterExisting: async (paths) => new Set(paths),
        },
      ]);
    }

    function toolOf(sources: Map<string, SmartSource>, corpus = makeFakeCorpusIndex(sources)) {
      return registerTool(
        buildFindDuplicatesTool({
          registry: vaultOf(sources, corpus),
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        }),
      );
    }

    it('find_duplicates reports a pair once, note_a before note_b', async () => {
      const sources = new Map([
        ['Folder/b.md', makeSyntheticSource('Folder/b.md', [1, 0, 0])],
        ['Folder/a.md', makeSyntheticSource('Folder/a.md', [1, 0, 0])],
      ]);

      const results = await callTool<DuplicateResults>(toolOf(sources), { threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([['Folder/a.md', 'Folder/b.md']]);
    });

    it('reports one pair once when two paths differ only by Unicode normalisation', async () => {
      const nfc = 'Folder/Caf\u00e9.md';
      const nfd = 'Folder/Cafe\u0301.md';
      // The premise: localeCompare calls them equal, so only a code-unit tie-break orders them
      // (NFD first: 'e' is below 'é' by code unit).
      expect(nfc.localeCompare(nfd)).toBe(0);
      expect(nfc).not.toBe(nfd);
      const sources = new Map([
        [nfd, makeSyntheticSource(nfd, [1, 0, 0])],
        [nfc, makeSyntheticSource(nfc, [1, 0, 0])],
      ]);

      const results = await callTool<DuplicateResults>(toolOf(sources), { threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([[nfd, nfc]]);
    });

    it('find_duplicates batches anchors by 64', async () => {
      expect(DUPLICATE_ANCHOR_BATCH).toBe(64);
      const sources = new Map<string, SmartSource>();
      for (let i = 0; i < 130; i += 1) {
        const notePath = `Notes/n${String(i).padStart(3, '0')}.md`;
        sources.set(notePath, makeSyntheticSource(notePath, [1, 0, 0]));
      }
      const corpus = makeFakeCorpusIndex(sources);

      await callTool<DuplicateResults>(toolOf(sources, corpus), { threshold: 0.99 });

      expect(corpus.nearest.mock.calls.map(([anchors]) => anchors.length)).toEqual([64, 64, 2]);
    });

    it('skips a note without a vector instead of failing', async () => {
      const sources = new Map([
        ['a.md', makeSyntheticSource('a.md', [1, 0, 0])],
        ['b.md', makeSyntheticSource('b.md', [1, 0, 0])],
        ['short.md', makeSyntheticSource('short.md', [])],
      ]);

      const results = await callTool<DuplicateResults>(toolOf(sources), { threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([['a.md', 'b.md']]);
    });

    it('returns today’s pairs, in today’s order, with today’s similarities', async () => {
      // Deterministic pseudo-random vectors, with exact copies (ties) and mixed-case paths so
      // the localeCompare fold and the three-key sort are both exercised.
      let seed = 7;
      const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
      const names = ['Zeta', 'alpha', 'Alpha', 'beta', 'Beta', 'gamma', 'delta', 'Delta'];
      const sources = new Map<string, SmartSource>();
      const make = (name: string, vector: number[]) =>
        sources.set(`Folder/${name}.md`, makeSyntheticSource(`Folder/${name}.md`, vector));
      for (const name of names) make(name, [next(), next(), next(), next()]);
      for (let i = 0; i < 20; i += 1) make(`n${i}`, [next(), next(), next(), next()]);
      make('copy-1', [0.3, 0.4, 0.5, 0.6]);
      make('copy-2', [0.3, 0.4, 0.5, 0.6]);
      make('copy-3', [0.3, 0.4, 0.5, 0.6]);

      for (const threshold of [0, 0.5, 0.9]) {
        const expected = legacyFindDuplicates({ sources: sources.values(), threshold });
        const results = await callTool<DuplicateResults>(toolOf(sources), { threshold });

        expect(expected.length).toBeGreaterThan(0);
        expect(results.map(({ vault: _vault, ...pair }) => pair)).toEqual(expected);
      }
    });
  });
});
