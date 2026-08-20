## 1. The adapter and its wiring — sequential

Groups 1 and 2 must land before group 3. Nothing in group 3 compiles until `IVaultEntry.filterExisting` exists.

- [x] 1.1 Write `test/lib/obsidian/existing-paths.test.ts` covering the adapter's contract from spec Requirement 3: survivors reported for a mixed present/absent input, duplicate input paths checked once, a missing path resolving normally rather than raising, an empty input yielding an empty result without filesystem access, and paths resolved against the given vault root. Tests fail — the module does not exist yet.
- [x] 1.2 Add `src/lib/obsidian/existing-paths.ts` beside `vault-conventions.ts`: a factory `createExistingPathFilter({ vaultRoot })` returning `(paths: Iterable<string>) => Promise<Set<string>>` that deduplicates, checks each path with `fs.access` in parallel, and returns the survivors. Export it from `src/lib/obsidian/index.ts` if that barrel is the module's convention. Group 1.1's tests pass.
- [x] 1.3 Extend `test/lib/vault-registry.test.ts`: `VaultRegistry.create` calls `existingPathFilterFactory` once per vault with that vault's root, and the resulting `filterExisting` is reachable on each entry, bound to its own root (two vaults sharing a relative path get independent verdicts — spec Requirement 3, third scenario).
- [x] 1.4 Add `filterExisting` to `IVaultEntry` and `existingPathFilterFactory` to `IVaultEntryDeps` in `src/lib/vault-registry.ts`, assembled in `VaultRegistry.create` alongside `readConventions`. Document `filterExisting` with a doc comment stating the staleness obligation it discharges, matching the `readConventions` comment's depth. Group 1.3's tests pass; `npx tsc --noEmit` now flags every unsatisfied entry construction.
- [x] 1.5 Wire the real factory into `buildDefaultVaultEntryDeps` in `src/server.ts`.

## 2. Test-rig default — sequential, after group 1

- [x] 2.1 Add a `filterExisting` default to `makeTestRegistry` in `test/operations/tools/_test-registry.ts`, bound to the partial entry's `path` via the real adapter, next to the existing `semanticAvailable` / `reader` / `readConventions` defaults. Verify the whole suite is green with the three private copies still in place — this task must change no behaviour.

## 3. Move the three call sites — parallel-safe within the group

3.1/3.2/3.3 touch disjoint files and share no state; they may be dispatched in parallel. Each is complete only when the full suite passes, since they share the test-rig default from group 2.

- [x] 3.1 `src/modules/semantic/tools/find-duplicates.ts` — delete the private `buildExistingPathSet`, call `entry.filterExisting` with the flattened pair paths, drop the now-unused `pathExistsForEntry` import. `test/semantic/tools/find-duplicates.test.ts` passes unchanged. This is the smallest of the three; do it first if running sequentially.
- [x] 3.2 `src/modules/semantic/tools/search-notes.ts` — delete the private `buildExistingPathSet` and call `entry.filterExisting` at the same seam (`search-notes.ts:452`), preserving the surrounding comment about why `assembleUnified` recomputes `flattenExpansion` from the filtered seeds. Seeds and each seed's `related[]` still filter against one set.
- [x] 3.3 `src/modules/semantic/tools/get-similar-notes.ts` — split `filterCandidates` into local prefix-exclusion plus one `entry.filterExisting` call, keeping exclusion first (design D4). The existing staleness test in `test/semantic/tools/get-similar-notes.test.ts` must be passing before the edit and unchanged after it; add a case covering a candidate that is both excluded and missing (spec Requirement 4, second scenario).

## 4. Close the seam — sequential, after group 3

- [x] 4.1 Delete `pathExistsForEntry` from `src/modules/semantic/tool-helpers.ts`; leave `readNoteContentForEntry`, which still has a caller. `npx tsc --noEmit` proves no reference remains.
- [x] 4.2 Add a substitution test proving the adapter is injectable without disk (spec Requirement 2, second scenario): a tool test that supplies a fake `filterExisting` through `makeTestRegistry` and observes the tool drop those paths, with no temp directory created.
- [x] 4.3 Grep `src/` for any remaining path-existence filtering of corpus results and confirm exactly one implementation (spec Requirement 2, third scenario).

## 5. Docs — parallel-safe with group 4

- [x] 5.1 `docs/architecture/smart-connections-corpus.md` — state the staleness obligation as a consequence of the read-only, unwatched corpus, and name `IVaultEntry.filterExisting` as its single owner. Do not amend ADR-0006 (immutable per ADR-0008).
- [x] 5.2 `docs/architecture/vault-registry.md` — document `filterExisting` / `existingPathFilterFactory` as a per-entry capability alongside `readConventions`.
- [x] 5.3 Sweep all of `docs/` — including `docs/guide/` — for prose describing existence checking as per-tool behaviour, and update it to name the one adapter.

## 6. Gates — sequential, last

- [x] 6.1 `npm test`, `npm run lint`, and `npx tsc --noEmit` all pass. Record the test count against the pre-change count; it must not silently drop (baseline spec).
- [x] 6.2 Confirm no MCP contract moved: no tool description, parameter, response field, or error code changed in this diff.
