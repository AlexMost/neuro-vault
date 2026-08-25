# Verification: own-corpus-indexer

Date: 2026-08-25 · against `worktree-own-corpus-indexer-pr2` (PR #96 merged, PR #97 open)

## Summary

| Dimension    | Status                                              |
| ------------ | --------------------------------------------------- |
| Completeness | 45/45 tasks · 18 requirements, all implemented      |
| Correctness  | 39/39 scenarios covered (one gap found and closed)  |
| Coherence    | D1–D13 followed · one spec contradiction fixed      |

## Completeness

Every task in `tasks.md` is checked. The 18 requirements across the three delta
specs map onto shipped code:

| Capability              | Requirements | Where                                                                                          |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `embed-text-extraction` | 7            | `src/lib/obsidian/corpus/chunker.ts`, `embed-text.ts`, `src/modules/semantic/embedding-service.ts` |
| `own-corpus-index`      | 10           | `src/lib/obsidian/corpus/shard-store.ts`, `vector-codec.ts`, `reconcile.ts`                     |
| `vault-scope` (MODIFIED) | 1           | `reconcile.ts` takes its path set from the scoped scan and applies no rule of its own            |

108 tests cover the corpus library and the embedding-service cap; the full suite
is 1161.

## Correctness

One coverage gap, now closed:

- **"An exclusion change is not a rebuild"** was exercised only on a single-note
  vault, which cannot show that untouched notes survive a membership change. A
  case was added that drops one note from scope, adds another, and asserts the
  third shard and the manifest are byte-identical afterwards.

Scenarios that deserved an explicit look, all covered:

- Renamed note re-embedded and old shard unlinked; identical content at two
  paths yields two distinct vectors; incremental equals from-scratch (property-style test).
- Corrupt, mis-hashed and wrong-dimension shards read as absent and are repaired
  on the next pass, never thrown.
- `.gitignore` append is idempotent, never creates the file, warns and continues
  when unwritable.
- An over-long input returns a vector instead of crashing ONNX.

## Coherence

- **D1 (layering)** — `src/lib/obsidian/corpus/` imports nothing from
  `src/modules/`; a test greps every file in the directory, and `reconcile.ts`
  satisfies it.
- **D12 (internal only)** — the branch diff touches no MCP tool, no registry, no
  server wiring. Nothing imports `reconcile.ts` yet; Smart Connections still
  serves every semantic tool.
- **D2 (parity constants)** — `MIN_CHARS` 200, `EMBED_CHAR_BUDGET` 1894,
  strategy `sc-parity-v1`, all pinned by tests.

One contradiction found **between** artifacts and fixed:

- The `vault-scope` delta said the corpus holds an entry for every visible note
  "except those below the embedding size gate", while `own-corpus-index`
  requires a gated note to still get a vector-less shard — which is what the
  code does, and how a short note avoids being re-read on every pass. The scope
  scenario was reworded to match, so the archive does not sync a wrong
  requirement into the main spec.

## Deviations recorded rather than silent

- `ReconcileDeps` carries a `stat` port that plan.md's Task 10 interface block
  does not list; without it, "skips the note without reading it" is
  unimplementable. Noted in `tasks.md` under group 7.
- `EmbeddingService`'s default `modelKey` was the corpus `MODEL_KEY`
  (`bge-micro-v2`), not a loadable transformers.js repo id. Found by the
  real-vault sanity run, fixed with a new `MODEL_ID` constant and a regression
  test. Noted in `tasks.md` under 9.4.
- ADR number: 0012 was taken by a release that landed between design and apply;
  the corpus ADR is **0013**.

## Gates

`npm test` (1161 passed) · `npm run lint` · `npm run typecheck` ·
`npx openspec validate --all` (14 passed, 0 failed) — all green. CI green on PR #97.

**Assessment: no critical issues. Ready for archive.**
