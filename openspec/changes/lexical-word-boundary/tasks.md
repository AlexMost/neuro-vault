# Tasks — lexical-word-boundary

One PR, `Closes #231`. Groups 1 and 2 touch disjoint files (`match.ts`, `blocks.ts`) and are
parallel-safe with each other. Group 3 needs both: it pins the behaviour end to end and updates
the advertised text. Group 4 needs 1–3. Group 5 is last.

## 1. Word-prefix matching (parallel-safe with 2)

- [ ] 1.1 `matchUnit` (`src/lib/obsidian/lexical/match.ts`) accepts a phrase or token
      occurrence only at a word boundary (design D1, D2): index 0, or the preceding code point
      is not `\p{L}`, `\p{N}`, `_` or `'`. It takes the first qualifying occurrence, and
      `firstIndex` points at it. Tests in a new `test/lib/obsidian/lexical/match.test.ts`:
      `пошук` matches `пошуком`; `api` does not match `rapid`; `arguments` does not match
      `tolerant_arguments`; `єкт` does not match `об'єкт`; `arguments` matches
      `tolerant-arguments`; a phrase inside a longer word does not match as a phrase, and the
      phrase match's `firstIndex` skips an earlier in-word occurrence; a token preceded by a
      non-BMP letter does not match.
- [ ] 1.2 A phrase or token whose first character is not a letter or digit matches at any
      occurrence (design D3). Tests: `/api` matches `v2/api/notes`; `.env` matches `x.env`.

## 2. Drawing payloads (parallel-safe with 1)

- [ ] 2.1 `parseNote` (`src/lib/obsidian/lexical/blocks.ts`) skips `code` nodes whose `lang`
      is `compressed-json` (design D4). Tests in `test/lib/obsidian/lexical/blocks.test.ts`: an
      Excalidraw-shaped body (`## Text Elements`, a text paragraph, `%%`, `## Drawing`, a
      `compressed-json` fence) yields no unit holding the payload, keeps the text-elements
      paragraph, and a `json` fence is still a body unit.

## 3. Behaviour pins and advertised semantics (needs 1 and 2)

- [ ] 3.1 `rank.test.ts`: the existing "inflected forms match by substring" test is renamed to
      word prefix; new tests: an in-word occurrence yields no candidate and a zero
      `perQueryCounts`; `perQueryTokenCounts` counts a token only at a boundary; a drawing
      payload is neither a candidate nor counted.
- [ ] 3.2 `search_notes` description (`src/modules/semantic/tools/search-notes.ts`): the
      `LEXICAL MATCHING:` line says word-prefix (a token matches at the start of a word, its end
      is free), within the description budget. Test pins the line in
      `test/semantic/tools/search-notes-description.test.ts`.
- [ ] 3.3 Docs: `docs/architecture/lexical-search.md` (intro, pipeline diagram, normalize
      chain's matching paragraph, §5, the per-token paragraph, "does not do", and §3 for the
      payload skip), `docs/guide/finding-notes.md`, `docs/guide/routing.md`, `GLOSSARY.md`
      *Lexical leg*. Sweep all of `docs/` for "substring" claims about the lexical leg.

## 4. Gates and measurement (needs 1–3)

- [ ] 4.1 `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass.
- [ ] 4.2 Production eval before (main) and after (branch) on the same vault sha: `lexical` and
      `fused`, quick and deep. Record controls returning anything, mean notes, hit@3, recall@10
      against the guard (lexical hit@3 / R@10 ≥ 0.714 / 0.557; fused hit@3 not dropping).

## 5. Close-out (sequential, last)

- [ ] 5.1 verify.md, retrospective.md, archive (syncs the spec delta), then the PR with
      aggregate numbers only.
