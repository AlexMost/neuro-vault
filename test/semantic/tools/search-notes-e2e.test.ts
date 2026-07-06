import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import type { SearchEngine, SmartSource } from '../../../src/modules/semantic/types.js';
import { makeLexicalVault } from './_hybrid-helpers.js';

// End-to-end sanity fixture for hybrid `search_notes`: a real vault on disk
// (real `FsVaultReader`, real markdown parser via `LexicalIndex`), with only
// the embedding layer (corpus sources + `SearchEngine`) faked. Each `it` is
// an independent vault fixture exercising one behavior called out in
// openspec/changes/hybrid-search-notes/specs/hybrid-search/spec.md — see the
// scenario -> test mapping table in the task report.

describe('search_notes end-to-end sanity fixture', () => {
  it('a note hit by BOTH legs appears in semantic_matches AND lexical_matches (intersection)', async () => {
    const notePath = 'Retrieval eval harness.md';
    const sources = new Map<string, SmartSource>([
      [notePath, { path: notePath, embedding: [1, 0], blocks: [] }],
    ]);
    // The semantic leg's neighbor lookup is faked to surface the SAME path
    // that the lexical leg finds via a title match, wiring the intersection.
    const engine: SearchEngine = {
      findNeighbors: vi.fn().mockReturnValue([{ path: notePath, similarity: 0.92 }]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'Notes on building a retrieval evaluation harness for the search stack.\n' },
      { sources, engine },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'retrieval eval harness' })) as SearchNotesOutput;

      expect(out.semantic_matches.map((m) => m.path)).toContain(notePath);
      expect(out.lexical_matches.map((m) => m.path)).toContain(notePath);
      const lexicalHit = out.lexical_matches.find((m) => m.path === notePath);
      expect(lexicalHit?.matches[0]).toMatchObject({ matched_in: 'title' });
    } finally {
      await cleanup();
    }
  });

  it('Ukrainian apostrophe + case: uppercase U+2019 query matches a U+0027 body', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'Note.md': "У цьому тексті є слово об'єкт написане звичайною лапкою.\n" },
      { semantic: false },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      // Query uses U+2019 (') uppercase; the file uses U+0027 (') lowercase.
      const out = (await tool.handler({
        query: 'ОБ’ЄКТ',
        mode: 'lexical',
      })) as SearchNotesOutput;

      expect(out.lexical_matches).toHaveLength(1);
      expect(out.lexical_matches[0]).toMatchObject({ path: 'Note.md' });
      expect(out.lexical_matches[0]!.matches[0]).toMatchObject({ matched_in: 'body' });
    } finally {
      await cleanup();
    }
  });

  it('filter: { path_prefix: "Tasks/" } excludes an Archive/ note from BOTH legs', async () => {
    const tasksPath = 'Tasks/Retrieval task.md';
    const archivePath = 'Archive/Retrieval archive.md';
    const sources = new Map<string, SmartSource>([
      [tasksPath, { path: tasksPath, embedding: [1, 0], blocks: [] }],
      [archivePath, { path: archivePath, embedding: [1, 0], blocks: [] }],
    ]);
    // Echoes back whatever sources it was actually given, so if `Archive/`
    // leaks past the filter into the semantic leg's candidate set, it shows
    // up in the result — proving the filter narrows the corpus, not just the
    // final output.
    const engine: SearchEngine = {
      findNeighbors: vi.fn(({ sources: passed }) =>
        [...(passed as Iterable<SmartSource>)].map((s) => ({ path: s.path, similarity: 0.9 })),
      ),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      {
        [tasksPath]: 'пошук у задачах\n',
        [archivePath]: 'пошук в архіві\n',
      },
      { sources, engine, listMatchingPaths: async () => new Set([tasksPath]) },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        filter: { path_prefix: 'Tasks/' },
      })) as SearchNotesOutput;

      expect(out.semantic_matches.map((m) => m.path)).toEqual([tasksPath]);
      expect(out.lexical_matches.map((m) => m.path)).toEqual([tasksPath]);
    } finally {
      await cleanup();
    }
  });

  it('mode: "lexical" on a semanticAvailable: false vault returns full lexical results, semantic_matches: []', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'Cold corpus note.md': 'холодний корпус і пошук без embedding\n' },
      { semantic: false },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        mode: 'lexical',
      })) as SearchNotesOutput;

      expect(out.semantic_matches).toEqual([]);
      expect(out.lexical_matches).toHaveLength(1);
      expect(out.lexical_matches[0]).toMatchObject({ path: 'Cold corpus note.md' });
    } finally {
      await cleanup();
    }
  });
});
