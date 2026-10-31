# PROTOTYPE — wording for structural reads (issue 253)

Throwaway, never merged. Answers: how do the `read_notes` / `search_notes` descriptions and
`docs/guide` teach structural reads so a model picks the right rung and reads every field right?

- `read-notes.A-full.md` — the candidate `read_notes` description (also pasted into
  `src/modules/operations/tools/read-notes.ts`; the input schema there is NOT updated).
- `read-notes.B-lean.md` — the lean alternative, probed in round 1 and dropped.
- `search-notes.addition.md` — two RESPONSE SHAPE lines for `search_notes` (also in
  `src/modules/semantic/tools/search-notes.ts`).
- `docs/guide/reading-and-modifying.md`, `finding-notes.md`, `routing.md` — guide drafts
  (see the branch diff against `main`).
- `probe/` — synthetic fixtures, 17 questions, round-1 and round-2 scores (Haiku).
