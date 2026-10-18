import { describe, expect, it } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import type { SmartSource } from '../../../src/modules/semantic/types.js';
import { callTool } from '../../_gate.js';
import { makeLexicalVault, sourcesScoring } from './_hybrid-helpers.js';

// End-to-end sanity fixture for hybrid `search_notes`: a real vault on disk
// (real `FsVaultReader`, real markdown parser via `LexicalIndex`), with only
// the embedding layer (corpus sources + query vectors) faked. Each `it` is
// an independent vault fixture exercising one behavior called out in
// openspec/changes/search-notes-unified-rank/specs/hybrid-search/spec.md —
// now asserted against the unified `matches[]`/`found_in` shape.

describe('search_notes end-to-end sanity fixture', () => {
  it('a note hit by BOTH legs surfaces once in matches[] with both provenance kinds', async () => {
    const notePath = 'Retrieval eval harness.md';
    // The semantic leg surfaces the SAME path that the lexical leg finds via
    // a title match, wiring the intersection.
    const sources = sourcesScoring([{ path: notePath, similarity: 0.92 }]);
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'Notes on building a retrieval evaluation harness for the search stack.\n' },
      { sources },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'retrieval eval harness' });

      expect(out.matches).toHaveLength(1);
      const m = out.matches[0];
      expect(m.path).toBe(notePath);
      expect(m.found_in).toContain('semantic');
      expect(m.found_in).toContain('lexical:title');
      expect(m.similarity).toBeCloseTo(0.92, 6);
      expect(m.lexical?.[0]).toMatchObject({ matched_in: 'title' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      // Query uses U+2019 (') uppercase; the file uses U+0027 (') lowercase.
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'ОБ’ЄКТ',
        mode: 'lexical',
      });

      expect(out.matches).toHaveLength(1);
      expect(out.matches[0]).toMatchObject({ path: 'Note.md' });
      expect(out.matches[0].found_in).toEqual(['lexical:body']);
      expect(out.matches[0].lexical?.[0]).toMatchObject({ matched_in: 'body' });
    } finally {
      await cleanup();
    }
  });

  it('filter: { path_prefix: "Tasks/" } excludes an Archive/ note from the merged list', async () => {
    const tasksPath = 'Tasks/Retrieval task.md';
    const archivePath = 'Archive/Retrieval archive.md';
    const sources = new Map<string, SmartSource>([
      [tasksPath, { path: tasksPath, embedding: new Float32Array([1, 0]), blocks: [] }],
      [archivePath, { path: archivePath, embedding: new Float32Array([1, 0]), blocks: [] }],
    ]);
    // Both notes sit on the query vector, so if `Archive/` leaks past the
    // filter into the semantic leg's candidate set, it shows up in the result
    // — proving the filter narrows the corpus, not just the final output.
    const { deps, cleanup } = await makeLexicalVault(
      {
        [tasksPath]: 'пошук у задачах\n',
        [archivePath]: 'пошук в архіві\n',
      },
      { sources, listMatchingPaths: async () => new Set([tasksPath]) },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        filter: { path_prefix: 'Tasks/' },
      });

      expect(out.matches.map((m) => m.path)).toEqual([tasksPath]);
      const m = out.matches[0];
      expect(m.found_in).toContain('semantic');
      expect(m.found_in.some((s) => s.startsWith('lexical:'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('mode: "lexical" on a vault with no semantic backend returns full lexical results with no semantic fields', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'Cold corpus note.md': 'холодний корпус і пошук без embedding\n' },
      { semantic: false },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        mode: 'lexical',
      });

      expect(out.matches).toHaveLength(1);
      expect(out.matches[0]).toMatchObject({ path: 'Cold corpus note.md' });
      expect(out.matches[0].found_in).toEqual(['lexical:body']);
      expect(out.matches[0].similarity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
