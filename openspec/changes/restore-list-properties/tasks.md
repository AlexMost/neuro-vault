<!--
NOTE: this change was implemented in the working tree ahead of the OpenSpec
formalization (same session). Tasks below are checked off to reflect the
actual state; the remaining work is the verify gate re-run and the release.
Groups 1–3 were parallel-safe in principle (no shared state between tool file,
docs, and instructions) but were executed sequentially in one session.
-->

## 1. Tool restoration (sequential — registration depends on the tool file)

- [x] 1.1 Restore `src/modules/operations/tools/list-properties.ts` as a near-verbatim revert of the v10 wrapper, mirroring `list_tags` (vault param, `runFanOut`, `{ vault, results }`), with a description stating the complete-inventory-vs-truncated-overview differentiator and the consistency-audit use case
- [x] 1.2 Register the tool: add `list_properties` to `TOOL_NAMES` in `src/lib/tool-names.ts` and to `buildOperationsTools` in `src/modules/operations/tools/index.ts`, directly after `list_tags`
- [x] 1.3 Re-add `ListPropertiesToolInput` and the `listProperties` handler signature to `src/modules/operations/types.ts` (symmetry with `listTags`)

## 2. Tests (sequential after group 1; TDD pairing per task)

- [x] 2.1 Update `test/operations/tools.test.ts`: registration array/count 10 → 11, add a description test pinning "ALL frontmatter properties" / "complete inventory" / `get_vault_overview` cross-reference
- [x] 2.2 Update `test/server-modules.test.ts`: add `list_properties` to both registered-name arrays, flip `not.toContain('list_properties')` to `toContain`, retitle combined test 13 → 14 tools (3 semantic + 11 operations)
- [x] 2.3 Update `test/operations/operations-module.test.ts`: tool count 10 → 11

## 3. Descriptions, instructions, and docs (parallel-safe with group 2)

- [x] 3.1 `src/modules/operations/tools/get-vault-overview.ts`: mark the property list as top entries only and point at `list_properties` for the full inventory
- [x] 3.2 `src/server.ts` instructions: re-add `list_properties` to the probe-step fallback, the Frontmatter properties section (with the truncation caveat and audit use case), the orientation hint, and the multi-vault fan-out list
- [x] 3.3 `README.md`: add `list_properties` to the multi-vault fan-out tool list
- [x] 3.4 `docs/guide/reading-and-modifying.md`: add the `list_properties` section, cross-reference it from `get_vault_overview`, add it to the fan-out failure note

## 4. Verify and release (sequential, after all groups)

- [x] 4.1 Repo gates: `npx tsc --noEmit` clean, `npm run lint` clean, full vitest suite green (748/748, count did not drop)
- [ ] 4.2 Commit as `feat(tools): restore list_properties` (Conventional Commits), PR to `main`
- [ ] 4.3 After merge: `npm run release` on `main` → 12.1.0; notify the downstream consumer that the vault-health sweep is unblocked
