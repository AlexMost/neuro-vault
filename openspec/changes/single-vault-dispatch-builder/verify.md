# Verification — single-vault-dispatch-builder

**Schema:** superpowers-bridge · **Issue:** #111 · **Verified at:** `437f7e1`

## Summary

| Dimension    | Status                                                     |
| ------------ | ---------------------------------------------------------- |
| Completeness | 13/13 tasks complete · 5/5 requirements implemented        |
| Correctness  | 12/12 scenarios covered                                    |
| Coherence    | D1–D6 followed · no pattern deviations                     |

**Gates at verify time:** `npm test` 1347 passed (108 files) · `npm run lint` clean · `npm run typecheck` clean · `npm run build` clean.

## Completeness

All 13 `tasks.md` items and all 32 `plan.md` steps are checked. Delta requirements map to source as follows:

| Requirement                                                    | Implementation                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| One builder owns the explicit-vault dispatch contract          | `src/lib/single-vault-tool.ts`; nine consumers under `src/modules/**`             |
| Explicit-vault dispatch resolves the vault identically         | `buildSingleVaultTool` handler → `resolveVault`                                  |
| Semantic explicit-vault tools resolve through the readiness gate | `ISemanticVaultToolSpec` + `resolveSemanticVault` branch                        |
| The contract text is identical and final in every description  | builder composes `${description}\n\n${block}`; `describeMultiVault` returns bare |
| (MODIFIED) The fan-out contract text is identical              | `src/lib/multi-vault-tool.ts` — separator heuristic deleted                      |

Boundary evidence: `grep -rn "resolveVault\|resolveSemanticVault\|vaultParamShape\|describeMultiVault\|EXPLICIT_VAULT_SUFFIX" src/modules/` returns one hit, a prose comment in `search-notes.ts:128` — no imports. The ESLint `no-restricted-imports` override on `src/modules/**` was probed with the verbatim `npm run lint`: a temporary `resolveVault` import in `remove-property.ts` failed the gate with the restriction message, and the probe was reverted.

## Correctness — scenario coverage

| Scenario                                                        | Covered by                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| No tool file composes the dispatch contract by hand              | `eslint.config.js` `no-restricted-imports` (probed, fails on violation)          |
| A new explicit-vault tool costs one per-vault function           | `ISingleVaultSpecBase` — `inputShape: z.ZodRawShape & { vault?: never }`          |
| Omitted vault in multi-vault mode is refused                     | `single-vault-tool.test.ts` — `VAULT_REQUIRED` + `details` assertion              |
| An explicit vault targets one vault                              | `single-vault-tool.test.ts` — "targets the named vault"                          |
| An unknown vault name fails the whole call                       | `single-vault-tool.test.ts` — `VAULT_NOT_FOUND`                                  |
| Single-vault mode needs no vault parameter                       | `single-vault-tool.test.ts` (advertisement) + `explicit-vault-prose.test.ts`     |
| A non-ready backend is refused before the per-vault function     | `single-vault-tool.test.ts` — `SEMANTIC_INDEX_BUILDING`, `ran === false`         |
| The suffix is the last paragraph of every explicit-vault description | `explicit-vault-prose.test.ts` — all nine registered tools                    |
| Single-vault mode omits the contract text entirely               | `explicit-vault-prose.test.ts`                                                   |
| All fan-out tools share byte-identical contract text             | `fan-out-prose.test.ts` (unchanged, passes)                                      |
| The registered vault names are stated once per description       | `vault-param.test.ts` — bare-block exact-string assertion                        |
| The multi-vault block is its own final paragraph regardless of layout | `multi-vault-tool.test.ts` — single-paragraph and multi-line cases; the `spec.description.includes('\n')` branch is gone from the source |

All behaviour tests for the new builder route through the registration gate (`registerTool` + `callTool`/`expectToolError`), per ADR-0015 and design D5. No new test calls `.handler` directly.

Prose preservation was proven independently of the tests: a throwaway `describe-dump.ts` rendered all 14 registered `tools/list` descriptions whitespace-normalized, once against `origin/main`'s `src/` and once against this branch. The diff has exactly one line — `create_note`, with the overwrite sentence moved ahead of the vault contract text (design D4). The other 13 descriptions are word-identical. The script was deleted afterwards.

## Coherence — design adherence

- **D1** (one builder, discriminated union) — `ISingleVaultToolSpec | ISemanticVaultToolSpec` on `semantic`; `entry.backend` reaches the two semantic tools typed and cast-free.
- **D2** (block is always its own final paragraph, both builders) — heuristic deleted from `multi-vault-tool.ts`; `describeMultiVault` returns the bare block; the transitional `.trimStart()` is gone.
- **D3** (ESLint, not a repo-scan test) — implemented as an override, not a test.
- **D4** (`create_note`'s overwrite warning moves before the suffix; `get_note_links` unfolds its array) — both done, words unchanged.
- **D5** (gate-routed builder tests) — see above.
- **D6** (spec home is `multi-vault-dispatch`) — delta extends the existing capability; no new capability directory.

Non-goals held: no parameter name, error code, or dispatch prose wording changed; the five fan-out tools' spec interface is untouched; no `annotations` / `outputSchema` / post-suffix hook was added; `multi-vault-tool.test.ts` stayed on its existing style rather than being converted to the gate helpers.

One addition beyond the plan's letter: `test/lib/explicit-vault-prose.test.ts`. The spec scenario "the suffix is the last paragraph of **every registered** explicit-vault tool" is a property of the nine registered descriptions, which the builder-level test cannot observe. It was probed against `origin/main`'s `create-note.ts` and fails there, so it is a real guard rather than a tautology.

## Issues

**CRITICAL:** none.
**WARNING:** none.
**SUGGESTION:** none.

`docs/adr/0010-context-delivery-channels.md:27` describes `describeMultiVault` as a helper whose "call site" concatenates the suffix, which the new placement rule supersedes. ADRs are immutable records of a decision at a point in time and the reference is not broken, so it was deliberately left unedited; `docs/architecture/fan-out.md` now carries the current mechanism.

**Assessment:** All checks passed. Ready for archive.
