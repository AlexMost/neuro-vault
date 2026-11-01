# Tasks — lexical-cut-note

One PR, `Closes #266`. Group 1 feeds 2; 3 needs both; 4 is last.

## 1. Count what each variant showed

- [x] 1.1 `runRetrievalPipeline` reports `perQueryShown` on the `ran` lexical record: per query,
      the final candidates whose lexical evidence names it (design D1). Test in
      `test/semantic/retrieval-pipeline.test.ts`: a lexical-only call with `cap: 1` over two
      matches shows 1 of 2.

## 2. `query_stats` for every query and the cut note

- [x] 2.1 `deriveObservability` builds `query_stats` for every query; `ObservabilityContext`
      drops `isMulti` and gains `hasFilter` (design D4).
- [x] 2.2 `queryStatsNote` emits the cut note when `shown < lexical <= CUT_NOTE_CEILING`, after
      the dead-variant notes and before the fallback note, the variant quoted as JSON, the
      filter named when the call had one (design D2, D3). Unit tests in
      `test/semantic/search-observability.test.ts`: the note's exact text; the filter form;
      none when shown in full; none above the ceiling, present at it; precedence over the
      fallback note; a quote inside the variant.

## 3. Tool contract and docs

- [x] 3.1 `search_notes` output type: `query_stats` required; description line says it covers
      a plain string. Budget test holds (4,050).
- [x] 3.2 Gate-level tests (`callTool`, real vault): a string query returns `query_stats`; a cut
      variant carries N, k and the call, and that call returns all N with no note; a variant
      above the ceiling carries none. The arity test expects `query_stats` at both arities.
- [x] 3.3 Docs: `docs/guide/finding-notes.md` (the `query_stats` section and the cut note),
      `configuration.md`, `mcp-parameter-dictionary.md`, `retrieval-policy.md`.

## 4. Verify and archive

- [x] 4.1 Gates: `npm test`, `lint`, `typecheck`, `format`, `build`.
- [x] 4.2 Review subagent over the whole diff; findings fixed or answered.
- [x] 4.3 `verify.md`, `retrospective.md`, then `npx openspec archive -y lexical-cut-note`.
