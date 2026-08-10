## 1. Weighted fusion in rank-fusion.ts

- [ ] 1.1 Add module-level `EXPANSION_WEIGHT = 0.85` and extend `fuseRanks` to accept an optional expansion weight (default `EXPANSION_WEIGHT`); apply `w / (k + i + 1)` to the expansion source only, semantic and lexical stay at weight 1 (TDD: failing test first — equal-rank expansion candidate must rank below the semantic candidate with an empty lexical leg)
- [ ] 1.2 Rework the comparator to `score desc → sourceCount desc → path asc` and remove the `getBacklinkCount` parameter from `fuseRanks` (TDD: failing test first — residual exact tie orders by path regardless of backlink counts)
- [ ] 1.3 Update the `assembleUnified` call site in `src/modules/semantic/tools/search-notes.ts` to stop passing `getBacklinkCount` into `fuseRanks` (the `backlink_count` response field it attaches per entry is untouched)

## 2. Regression fixtures for the report cases

- [ ] 2.1 Rewrite the two existing tie-break tests in `test/semantic/rank-fusion.test.ts` that assert the removed backlink behavior: "breaks score ties by source count, then backlinks, then path" (now score → sourceCount → path) and the exact-tie sourceCount test (keep its sourceCount intent, assert backlink irrelevance)
- [ ] 2.2 Add the retention-case fixture: empty lexical leg, parallel semantic and expansion lists where the expansion candidates carry higher backlink counts — assert semantic[i] precedes expansion[i] at every rank
- [ ] 2.3 Add the Moby-case fixture: a direct semantic hit vs an expansion-only high-similarity hub — assert the direct hit precedes the expansion-only entry
- [ ] 2.4 Add the RRF-health guard: a note present in two sources at mid-rank still precedes a single-source top hit under the new weights (protects multi-source reinforcement from over-correction)

## 3. Verification and delivery

- [ ] 3.1 Run `npm test && npm run lint && npm run typecheck` and confirm all pass
- [ ] 3.2 Run `openspec validate --all` to confirm the delta spec still validates
- [ ] 3.3 Update the tie-break wording in the `search_notes` architecture/docs surface if any file under `docs/architecture/` describes the fusion comparator (grep for `backlink` tie-break mentions); skip if none
- [ ] 3.4 Open a PR to `main` via `gh pr create` (single PR: code + tests + delta spec)
