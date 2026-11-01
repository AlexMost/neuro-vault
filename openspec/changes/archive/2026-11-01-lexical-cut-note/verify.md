# Verification Report

**Change**: `lexical-cut-note`
**Verified at**: `2026-11-01 20:55`
**Verifier**: Claude Opus 5.5, the session that wrote the change. It ran the gates and the
agent-level check. A fresh review subagent read the whole diff: no blocker, two should-fix
(spec scope, pinned vault), fixed in `fix(search): review follow-ups for the cut note`.

Scope: branch `feat/lexical-cut-hint`, one PR, `Closes #266`, on `main` after #264 and #265.

## 1. Structural Validation (`openspec validate --all --json`)

28 passed, 0 failed.

## 2. Task Completion (`tasks.md`)

All tasks checked.

## 3. Delta Spec Sync State

Three MODIFIED requirements of `hybrid-search`, each a full copy: "query_stats reports pre-cap
per-query hit counts" (string queries, the cut note, four new scenarios), "Semantic retrieval
is arity-invariant" (`query_stats` at both arities), and the two requirements that scoped
`query_stats` to arrays ("Multi-query and multi-vault keep their shapes", "search_notes
returns one RRF-ranked matches list").

## 4. Design / Specs Coherence Spot Check

| Scenario | Test |
|---|---|
| a plain string query reports its stats | `search-notes-e2e.test.ts` › the cut note; `search-observability.test.ts` › one entry for a string |
| a cut variant names the call | e2e (14 notes, 5 shown, then `limit: 14` returns 14, no note); unit exact text |
| shown in full / broad variant: no note | unit; e2e 51 notes |
| filter and pinned vault | unit |
| arity | `search-notes-hybrid.test.ts` › arity changes only which fields surface |

## 5. Implementation Signal

| Gate | Result |
|---|---|
| `npm test` | 3236 passed, 4 skipped |
| `npm run lint` / `typecheck` / `format` | clean |
| `npx commitlint --from origin/main --to HEAD` | clean |

**Agent-level check** (the only one that can show a behaviour change). Local build of this
branch over `main` (#264 + #265 + #266), `--no-shared`. Same questions, wrapper, brief and
limits as the A/B of PR #263. The fs arm was reused from it, and only the nv arm reran. Data
stays in the vaults' private eval folders (`agent-ab/2026-11-01-epic267-*`).

Small vault × Opus 5.5, single-token and name questions, 13 × 3 runs:

| | fs | nv before | nv after |
|---|---|---|---|
| single-token recall | 0.694 | 0.494 (Δ −0.200) | 0.606 (Δ **−0.089**) |
| name recall | 0.579 | 0.635 (Δ +0.056) | 0.659 (Δ +0.079) |
| tool calls per run (single-token) | 5.33 | 3.33 | 2.78 |
| cost per run (all 13) | — | $0.135 | $0.141 |

- A cut note reached the agent in 28 of 39 runs. In 13 of them a `mode: "lexical"` call
  followed it.
- q062 went from 0.33 to 1.00.
- q053 (a hyphenated term, "not yet specified" in #267) and q057 did not move.

Large vault × Haiku 5.5, cost guard, all 35 questions × 3:

| | nv before | nv after |
|---|---|---|
| cost per answer (answerable) | $0.0052 | $0.0056 (**+9%**, guard ≤ +10% ✓) |
| answerable recall | 0.899 | 0.891 |
| context per run | 26k | 30k |

## 6. Front-Door Routing Leak Detector

None: a tool-contract change, routed through opsx as `.claude/rules/opsx-routing.md` asks.

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

The agent-level check above is the dogfood.

## Overall Decision

Ship. The note does what it was for: agents follow it, and the recovered call returns everything.
On the epic's own done-when, the single-token gap is −0.089, not ≥ −0.05, and calls per run are
2.78, not ≤ 2.5. By #267's rule, the remainder is not lexical ranking: the misses left are a
hyphen spelling (q053) and agent search breadth.
