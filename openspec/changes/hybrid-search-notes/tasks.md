# Tasks — hybrid-search-notes

## 1. Markdown parser spike & dependency

- [ ] 1.1 Spike `mdast-util-from-markdown` vs `markdown-it` against ~10 real vault notes (wikilinks, callouts, fences, hard-wrapped paragraphs); confirm block nodes + line positions; record the pick and rationale in design.md §Open Questions
- [ ] 1.2 Add the chosen parser as a dependency; verify `npm run build` + `npx tsc --noEmit` stay green

## 2. Lexical core (pure functions, TDD)

- [ ] 2.1 `normalize()`: lowercase → NFKD → strip `\p{M}` → apostrophe unification → whitespace collapse; tests pin Cyrillic case folding, `й`→`и`/`ї`→`і` recall bias, apostrophe variants (U+0027/U+02BC/U+2019/U+2018), no `і`↔`и` merge
- [ ] 2.2 Note block extraction: title (filename sans `.md`), headings, body AST blocks with `lines: [start, end]` and enclosing section heading; fenced code is body-not-heading; frontmatter excluded; tests over hard-wrapped paragraphs and fences
- [ ] 2.3 Matcher: whitespace-tokenized query, AND-substring per unit, contiguous-phrase detection; tests incl. `tolerant arguments` matching `tolerant-arguments`/`tolerant_arguments` and phrase-across-linewrap
- [ ] 2.4 Tier ranking: six ordinal tiers + density + `backlink_count` + `path` tie-breaks; byte-for-byte determinism test; lazy cascade with early exit on filled cap, output-equivalence test vs full evaluation
- [ ] 2.5 Snippet windowing: ~150-char grapheme-safe window around first match with ellipses; tests on long paragraphs and emoji/combining clusters
- [ ] 2.6 mtime-keyed cache `path → { mtime, title, blocks }`: stat per request, re-parse changed files only; test that an edited note is visible next call

## 3. Tool integration (`search_notes`)

- [ ] 3.1 Input schema: `mode: "hybrid" | "lexical"` (default hybrid) × `effort: "quick" | "deep"` (default quick); old `mode: "quick"/"deep"` rejected; SDK-gate tests against `reg.spec.inputSchema` (advertisement + pre-validation, not handler-direct)
- [ ] 3.2 Response rename `results` → `semantic_matches`; add `lexical_matches` (grouped per note: `path`, `backlink_count`, `vault`, `matched_queries?`, `matches[]` with `matched_in`/`snippet`/`lines`/`heading`); `semantic_matches: []` in lexical mode; no numeric score on lexical items
- [ ] 3.3 Leg orchestration: hybrid runs both legs; `mode: "lexical"` never touches the corpus loader; lexical leg succeeds on cold/missing corpus (test with absent corpus fixture)
- [ ] 3.4 Caps & knobs: global lexical cap by `effort` (~5/~10), `limit` overrides in lexical mode, per-note `matches` cap (~3); `threshold` semantic-only
- [ ] 3.5 `filter` parity: reuse `listMatchingPaths` pre-filter for the lexical leg; test that `path_prefix`/`tags`/`frontmatter` exclusions bind both legs
- [ ] 3.6 Multi-query: per-query lexical match, merged ranked list, `matched_queries` annotation, top-level `truncated`; multi-vault fan-out wraps the hybrid shape (tests for both)

## 4. Docs & contract surface

- [ ] 4.1 Rewrite `search_notes` tool description: both legs, both axes, `limit`/`threshold` semantics per mode, lexical grouping shape
- [ ] 4.2 MCP parameter dictionary: add `effort`, redefine `mode`; note the breaking rename per ADR-0005
- [ ] 4.3 Restructure `docs/guide/` by intent (Finding notes / Reading & modifying / Routing); rewrite `routing.md` around the single search entry point; sync `guide/README.md`
- [ ] 4.4 Update `docs/architecture/` page for search (hybrid mechanism, mtime cache, tiers); CHANGELOG breaking notes (`results` → `semantic_matches`, `mode` → `mode`+`effort`)

## 5. Verification

- [ ] 5.1 Full gates green: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`
- [ ] 5.2 End-to-end sanity over a real vault fixture: hybrid query with intersection (note hits both legs), lexical-only on cold corpus, Ukrainian apostrophe/case queries, filter-bound search
