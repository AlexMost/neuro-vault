import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { IFanOutResult } from '../../../src/lib/fan-out.js';
import {
  makeTestRegistry,
  makeFakeGraph,
  makeFakeCorpusIndex,
  makeSearchDeps,
} from './_helpers.js';

function makeMockEngine() {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

async function makeLexicalVault(
  files: Record<string, string>,
  opts: { semantic: boolean } = { semantic: true },
) {
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
      corpus: opts.semantic ? makeFakeCorpusIndex(new Map()) : undefined,
      graph: makeFakeGraph(),
      listMatchingPaths: async () => new Set(Object.keys(files)),
      semanticAvailable: opts.semantic,
    },
  ]);
  const deps = {
    registry,
    embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
    searchEngine: makeMockEngine(),
    modelKey: 'k',
  };
  return { deps, cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }) };
}

describe('lexical leg orchestration', () => {
  it('hybrid returns lexical matches alongside (empty) semantic ones', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
      expect(out.lexical_matches).toHaveLength(1);
      expect(out.lexical_matches[0]).toMatchObject({
        path: 'Пошук.md',
        vault: 'v',
        backlink_count: 0,
        matches: [{ matched_in: 'title', snippet: 'Пошук' }],
      });
      expect(out.lexical_matches[0]).not.toHaveProperty('similarity');
    } finally {
      await cleanup();
    }
  });

  it('mode lexical works with NO corpus and does not touch the loader', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'n.md': "# Рішення\n\nоб'єкт тут.\n" },
      { semantic: false },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      // apostrophe variant in the query (U+2019) must still match (U+0027 in file)
      const out = (await tool.handler({ query: 'об’єкт', mode: 'lexical' })) as SearchNotesOutput;
      expect(out.semantic_matches).toEqual([]);
      expect(out.lexical_matches[0]!.matches[0]).toMatchObject({
        matched_in: 'body',
        heading: 'Рішення',
        lines: [3, 3],
      });
    } finally {
      await cleanup();
    }
  });

  it('hybrid on a cold corpus still returns lexical matches instead of throwing', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' }, { semantic: false });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
      expect(out.semantic_matches).toEqual([]);
      expect(out.lexical_matches).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('filter binds the lexical leg through listMatchingPaths', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Tasks/a пошук.md': '',
      'Archive/b пошук.md': '',
    });
    // narrow the allowed set to Tasks/ only
    deps.registry.list()[0]!.listMatchingPaths = async () => new Set(['Tasks/a пошук.md']);
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        filter: { path_prefix: 'Tasks/' },
      })) as SearchNotesOutput;
      expect(out.lexical_matches.map((n) => n.path)).toEqual(['Tasks/a пошук.md']);
    } finally {
      await cleanup();
    }
  });

  it('limit steers the lexical list in lexical mode', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b пошук.md': '',
      'c пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        mode: 'lexical',
        limit: 2,
      })) as SearchNotesOutput;
      expect(out.lexical_matches).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe('search_notes input axes (SDK gate)', () => {
  async function makeTool() {
    const { deps, cleanup } = await makeSearchDeps({
      sources: new Map(),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeMockEngine(),
      modelKey: 'k',
    });
    return { tool: buildSearchNotesTool(deps), cleanup };
  }

  it('rejects old mode values quick/deep', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      for (const bad of ['quick', 'deep']) {
        const parsed = tool.inputSchema.safeParse({ query: 'x', mode: bad });
        expect(parsed.success).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });

  it('accepts the new axes and defaults', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: 'x' }).success).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'hybrid', effort: 'deep' }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'lexical', effort: 'quick' }).success,
      ).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', effort: 'exhaustive' }).success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('response carries semantic_matches and lexical_matches, no results key', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      const out = await tool.handler({ query: 'x' });
      expect(out).toHaveProperty('semantic_matches');
      expect(out).toHaveProperty('lexical_matches');
      expect(out).not.toHaveProperty('results');
    } finally {
      await cleanup();
    }
  });
});

describe('multi-query and fan-out', () => {
  it('multi-query annotates lexical items with matched_queries', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Vector search.md': '',
      'Векторний пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['vector search', 'векторний пошук'],
      })) as SearchNotesOutput;
      expect(out.lexical_matches).toHaveLength(2);
      const byPath = Object.fromEntries(
        out.lexical_matches.map((m) => [m.path, m.matched_queries]),
      );
      expect(byPath['Vector search.md']).toEqual(['vector search']);
      expect(byPath['Векторний пошук.md']).toEqual(['векторний пошук']);
      expect((out as any).truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('multi-vault fan-out wraps the hybrid shape per vault', async () => {
    // build TWO lexical vaults and register both under one registry
    const a = await makeLexicalVault({ 'пошук a.md': '' });
    const b = await makeLexicalVault({ 'пошук b.md': '' }, { semantic: false });
    const registry = makeTestRegistry([...a.deps.registry.list(), ...b.deps.registry.list()]);
    // rename second entry to avoid the name collision
    registry.list()[1]!.name = 'w';
    try {
      const tool = buildSearchNotesTool({ ...a.deps, registry });
      const out = (await tool.handler({ query: 'пошук' })) as IFanOutResult<SearchNotesOutput>;
      expect(out).toHaveProperty('results_by_vault');
      expect(out.results_by_vault).toHaveLength(2);
      for (const vaultResult of out.results_by_vault) {
        // The fan-out envelope flattens per-vault fields alongside `vault`
        // (results_by_vault: [{ vault, ...T }]), not nested under `.result`.
        expect(vaultResult).toHaveProperty('semantic_matches');
        expect(vaultResult).toHaveProperty('lexical_matches');
      }
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
