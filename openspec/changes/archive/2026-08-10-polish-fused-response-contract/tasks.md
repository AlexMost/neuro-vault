## 1. Lexical leg — per-token diagnostics

- [x] 1.1 Extend `rankNotes` (`src/lib/obsidian/lexical/rank.ts`) to return `perQueryTokenCounts`: for each query with `perQueryCounts[q] === 0` and ≥2 normalized tokens, a second pass over the parsed notes counts, per token, the notes where that token alone matches title or any unit via the existing `matchUnit` normalization; TDD with unit tests covering the AND-killed case («ретеншн алертів» style), single-token dead queries (no entry), and matching queries (no entry)
- [x] 1.2 Thread `perQueryTokenCounts` through `LexicalIndex.search` (`src/lib/obsidian/lexical/lexical-index.ts` / `index.ts` exports) so `search-notes.ts` receives it alongside `perQueryCounts`

## 2. Semantic leg — block backfill

- [x] 2.1 Add the per-seed backfill step to `executeRetrieval` (`src/modules/semantic/retrieval-policy.ts`): after Step 4, each seed with zero blocks gets `findBlockNeighbors` scoped to that seed's source at `threshold: 0, limit: 1`; TDD via `test/semantic/retrieval-policy.test.ts` (starved seed gains its best block; a note with no block embeddings keeps `blocks: []` internally)
- [x] 2.2 Add the same backfill to `executeMultiRetrieval`, taking the maximum-similarity block across all query vectors for each starving seed; tests alongside

## 3. search_notes assembly and stats

- [x] 3.1 Widen `SearchNotesOutput.query_stats` to `{ semantic: number | null; lexical: number; lexical_tokens?: Record<string, number> }` and rework `buildQueryStats` (`src/modules/semantic/tools/search-notes.ts`) to take an explicit semantic-leg-ran signal: `null` on all three degradation paths (lexical mode, no corpus, empty-filter early return), numbers only when the leg executed; attach `lexical_tokens` from the lexical leg's counts; update the stale comment at lines 149-156
- [x] 3.2 In `assembleUnified`, omit the `blocks` key when a semantic node's backfilled `blocks` is still empty (never emit `blocks: []`)
- [x] 3.3 Update `SEARCH_NOTES_DESCRIPTION`: query_stats line (null semantics + `lexical_tokens`), RESPONSE SHAPE evidence line and INVARIANTS (`blocks[]` non-empty when present, may be absent for a semantic hit without block embeddings)
- [x] 3.4 Update/extend `test/semantic/tools/search-notes-e2e.test.ts` through the SDK gate (registered spec + handler, not handler-only): lexical-mode and no-corpus responses report `semantic: null`; empty-filter early return reports `semantic: null, lexical: 0`; no response contains `blocks: []`; AND-killed query carries `lexical_tokens`; sweep existing assertions that expect `semantic: 0` on degradation paths

## 4. Docs, verification, release prep

- [x] 4.1 Update the touched-field docs only: `docs/architecture/retrieval-policy.md` (backfill step), `docs/architecture/lexical-search.md` (per-token diagnostic), `docs/guide/finding-notes.md` (query_stats null semantics, `lexical_tokens`, blocks presence rule)
- [x] 4.2 Run `npm test && npm run lint && npm run typecheck` and confirm all green
- [ ] 4.3 Push branch and open PR to `main` via `gh pr create` (single PR — the three fixes ship together as one contract polish; release as major 15.0.0 on `main` after merge, not from the branch)
