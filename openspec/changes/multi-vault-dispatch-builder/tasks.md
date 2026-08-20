## 1. The builder and the shared prose — SEQUENTIAL (everything below depends on it)

- [x] 1.1 Add `FAN_OUT_SUFFIX` to `src/lib/vault-param.ts`, beside `EXPLICIT_VAULT_SUFFIX`. It describes `results_by_vault` and `failed_vaults` only — no `skipped_vaults` (design D3). Test first: `describeMultiVault(registry, FAN_OUT_SUFFIX)` prefixes the registered vault names in multi-vault mode and returns `''` in single-vault mode.
- [x] 1.2 Write the failing test file `test/lib/multi-vault-tool.test.ts` against a fake registry: omitted `vault` + multi-vault registry fans out; explicit `vault` targets one; single-vault registry never fans out and omits `vault` from the advertised input schema; an unknown vault name fails the whole call rather than landing in `failed_vaults`.
- [x] 1.3 Implement `src/lib/multi-vault-tool.ts` — `buildMultiVaultTool(registry, spec)` with `spec = { name, title, description, multiVaultNote?, inputShape, runForEntry, single }`. It merges `vaultParamShape(registry)` into the schema, appends `describeMultiVault(registry, FAN_OUT_SUFFIX + multiVaultNote?)`, and owns the dispatch branch (design D1).
- [x] 1.4 Add `withVaultName` and `payloadOnly` as named exports from the same module, generic over the payload, and assert both shapes in `test/lib/multi-vault-tool.test.ts` (design D2). No default `single` — the field is required.
- [x] 1.5 Assert the builder is registry-driven, not tool-driven: the same spec built against a one-vault and a two-vault fake registry produces the two different descriptions and schemas with no per-tool branching.

## 2. Migrate the four operations tools — PARALLEL-SAFE (one file each, no shared state; all depend on group 1)

- [x] 2.1 Migrate `src/modules/operations/tools/list-tags.ts` to `buildMultiVaultTool` with `single: withVaultName`. Delete its dispatch branch and its inline fan-out prose. Its `FanOutPayload` alias stays — group 5 decides whether it can go. Existing assertions in `test/operations/tools/list-tags.test.ts` and `test/operations/tools.test.ts` stay green.
- [x] 2.2 Migrate `src/modules/operations/tools/list-properties.ts` the same way (`single: withVaultName`). Keep the description assertions in `test/operations/tools.test.ts` (`ALL frontmatter properties`, `complete inventory`, `get_vault_overview`, `count`) green.
- [x] 2.3 Migrate `src/modules/operations/tools/query-notes.ts` with `single: payloadOnly` — it must NOT gain a top-level `vault` key. Delete the `skipped_vaults` sentence from its description. Its `QueryNotesResultRecord` alias stays — group 5 decides whether it can go. Keep the operator/field assertions in `test/operations/tools.test.ts` green, and add a regression asserting each result item still carries its own `vault`.
- [x] 2.4 Migrate `src/modules/operations/tools/get-vault-overview.ts` with `single: withVaultName`. Delete the `skipped_vaults` sentence. Its `VaultOverviewRecord` alias stays — group 5 decides whether it can go. Verify the `conventions` sentence survives verbatim — `vault-conventions-delivery` has requirements riding on that description.
- [x] 2.5 Update any existing test asserting the removed `skipped_vaults` description text; grep `test/` for the string before assuming there are none.

## 3. Migrate search_notes — SEQUENTIAL after group 2 (largest description surface, most special-casing)

- [x] 3.1 Migrate `src/modules/semantic/tools/search-notes.ts` to `buildMultiVaultTool` with `single: payloadOnly`. Pass its domain sentence ("A vault without a semantic index still contributes lexically-sourced matches; none are skipped.") as `multiVaultNote`.
- [x] 3.2 Delete its hand-rolled `Registered vaults: ...` block — `describeMultiVault` already emits exactly that (design D5). Assert the names appear exactly once in the resulting description.
- [x] 3.3 Keep the mid-description `- vault: target a specific vault by name when multiple are registered.` line in the `PARAMETERS:` section and the `registry.isMulti()` gate around it (design D5, accepted residue). Assert it is still present in multi-vault mode and absent in single-vault mode.
- [x] 3.4 Verify every existing `search_notes` description assertion in `test/semantic/tools/*.test.ts` still passes, and that the ordering of the joined description array is unchanged apart from the deleted tail.

## 4. The drift guarantee — SEQUENTIAL after group 3 (this is the load-bearing deliverable)

- [x] 4.1 Add a test that builds the full tool registry in multi-vault mode and asserts all five fan-out tools' descriptions contain the same `FAN_OUT_SUFFIX` substring byte for byte. Without this the change buys tidiness, not a drift guarantee (design Risks).
- [x] 4.2 Add a test asserting no registered tool description mentions `skipped_vaults`, while a fan-out response still carries `skipped_vaults: []`. Assert both halves — the point is that the field survives in the shape while leaving the prose.
- [x] 4.3 Assert via the SDK gate (`reg.spec.inputSchema`), not handler-direct, that each of the five advertises `vault` in multi-vault mode and omits it in single-vault mode — handler-direct tests miss advertisement bugs.

## 5. The generic constraint — SEQUENTIAL after group 4, contingent (design D4)

- [x] 5.1 Relax `IFanOutResult<T>` and `runFanOut<T>` in `src/lib/fan-out.ts` from `T extends Record<string, unknown>` to `T extends object`, then run `npm run typecheck`. This is authoritative — `isolatedModules` means a `tsup` build alone proves nothing.
- [x] 5.2 If 5.1 typechecks clean: delete the remaining `& Record<string, unknown>` aliases and the index-signature workaround at `src/modules/semantic/tools/search-notes.ts:81`. If it does not: revert 5.1, declare the constraint once inside the builder's generic, and record the failing diagnostic in verify.md. Both outcomes are acceptable — only the line-count win is contingent.
- [x] 5.3 Re-run `npm test && npm run lint && npm run typecheck` after whichever branch of 5.2 was taken.

## 6. Docs — PARALLEL-SAFE with group 5 (different files, no code dependency)

- [x] 6.1 Update `docs/architecture/fan-out.md`: add the builder as the fan-out entry point for tools, and state which single-vault shape each of the five follows. Its existing `skipped_vaults` section stays — it explains why the field remains in the shape, which is still the current state.
- [x] 6.2 Sweep all of `docs/` — including `docs/guide/` — for stale claims that each tool composes its own fan-out prose, and for any repetition of the `skipped_vaults` description wording. Architecture-scoped greps miss the model-facing guide layer.
- [x] 6.3 Confirm no ADR edit is made (design D6) and that `docs/architecture/fan-out.md` is the only place stating the new current state.

## 7. Gates — SEQUENTIAL, last

- [x] 7.1 `npm test && npm run lint && npm run typecheck` all green.
- [x] 7.2 `npx openspec validate --all` green.
- [x] 7.3 Confirm the acceptance criteria from design §Migration Plan: five tools registered, byte-identical fan-out prose, no `skipped_vaults` in any description, MCP wire contract otherwise unchanged.
