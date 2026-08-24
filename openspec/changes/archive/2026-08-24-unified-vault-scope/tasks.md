## 1. Scope module

- [x] 1.1 Add `picomatch` as a direct dependency (design D3 — it is transitive-only today; do not import the phantom copy) and its `@types/picomatch` dev types if needed for strict TS.
- [x] 1.2 Create the scope module in `src/lib/obsidian/` (e.g. `vault-scope.ts`): build from `{ vaultRoot, gitignoreLines, configExclusions }` a compiled scope exposing `ignorePatterns: string[]` (for fast-glob) and `isExcluded(relPath: string): boolean` (picomatch), with the three union layers from design D2 — unconditional dot-segment rule, `Templates/` + root-gitignore defaults, config globs. TDD: membership table tests first (dot-paths, Templates, gitignore subtree, config glob, agreement between the two views — spec `vault-scope` R1/R2/R3 scenarios).
- [x] 1.3 Implement the gitignore subset parser per design D4 (skip blank/comment/negation lines; strip trailing slash; entry excludes itself + `/**`; root-anchored). Test with a fixture containing negation lines and comments.

## 2. Per-vault config

- [x] 2.1 Create the `.neuro-vault/config.json` reader following the `vault-conventions.ts` best-effort pattern, but with a stderr warning naming the vault on unreadable/invalid-JSON/invalid-shape (design D5); missing file → silent defaults. Tests: spec `vault-scope` R4 scenarios (config entries union, missing-silent, invalid-warns-and-starts).

## 3. Wiring

- [x] 3.1 Add the scope to `IVaultEntry` and a `scopeFactory` to `IVaultEntryDeps` (`src/lib/vault-registry.ts`); build the scope per entry inside `VaultRegistry.create` (already async — read gitignore + config there). Wire the production factory in `buildDefaultVaultEntryDeps` (`src/server.ts`). Cover in `test/lib/vault-registry.test.ts`.
- [x] 3.2 Pass the scope's `ignorePatterns` into the fast-glob call in `FsVaultReader.scan` (`src/lib/obsidian/vault-reader.ts:103-108`); mind the `pathPrefix` case — glob runs with `cwd` moved to the prefix, so anchored patterns must still match correctly (re-anchor or filter with the predicate on prefixed scans). Update the two exact-options assertions in `test/lib/obsidian/vault-reader.test.ts` (L158-163, L204-209) and add scoped-scan cases.
- [x] 3.3 End-to-end membership tests over a real temp-dir vault (pattern of `test/operations/fs-vault-provider/_helpers.ts`): an excluded note is absent from lexical search, `query_notes`, `list_tags`/`list_properties` (spec `headless-vault-operations` new scenario), `get_vault_overview` counts, wikilink backlinks, and name resolution — and `read_notes` by explicit path still reads it (spec `vault-scope` R5).

## 4. Documentation

- [x] 4.1 Write `docs/architecture/vault-scope.md` — the concept file: layering, gitignore subset semantics, config contract, governed surfaces, discovery-not-ACL boundary, the deliberate `Untitled.md`-vs-SC diff note. Add it to `docs/architecture/README.md` index.
- [x] 4.2 Doc sweep of stale scan statements (design D6 consequence list): `docs/architecture/vault-reader.md`, `lexical-search.md`, `query.md`, `rank-fusion.md` (adaptive `k`'s N), `wikilink-graph.md`, `vault-provider.md`, `vault-registry.md`, `vault-conventions.md` (`.neuro-vault/` now holds config too), `obsidian-lib.md`; `docs/guide/configuration.md` (new config section) and `docs/guide/finding-notes.md` (some paths are never searchable). Sweep all of `docs/` including `docs/guide` (per repo feedback rule).
- [x] 4.3 State the behaviour change (gitignored vault paths leave discovery; live vault: `docs/superpowers/`) so it lands in the CHANGELOG: use a `feat` commit whose body carries the behaviour-change note.

## 5. Gates

- [x] 5.1 `npm test && npm run lint && npm run typecheck` all pass; `openspec validate --all` passes.
