## Why

The Smart Connections corpus is read-only and can name notes that no longer exist on disk, so every semantic tool must filter its results against the filesystem before returning them. That obligation is currently discharged by three private copies — two character-identical, one interleaved with unrelated exclusion logic — across `search_notes`, `find_duplicates`, and `get_similar_notes`. Remove any copy and it must be rewritten; add a fourth corpus-reading tool and it either copies again or silently returns ghost paths. Knowledge that reappears at three call sites is a missing module, and this one is cheap to build: the repo already proved the pattern with `readConventions`.

## What Changes

**Existence filtering**

- From: three private implementations — `buildExistingPathSet` in `search-notes.ts`, a verbatim copy in `find-duplicates.ts`, and a third variant inside `filterCandidates` in `get-similar-notes.ts` — each calling `pathExistsForEntry` directly.
- To: one `filterExisting(paths) => Promise<Set<string>>` on `IVaultEntry`, built by an `existingPathFilterFactory` in `IVaultEntryDeps`; all three handlers call it at the same seam the private copies occupied.
- Reason: one owner for a documented obligation, injectable in tests, discoverable by the author of the next corpus-reading tool.
- Impact: internal only. No MCP tool contract, parameter, response shape, or error code changes.

**`pathExistsForEntry`**

- From: exported from `src/modules/semantic/tool-helpers.ts`, called by three tools.
- To: deleted — no callers remain once the adapter owns the check.
- Reason: the deletion test. Leaving it exported invites a fourth copy.
- Impact: internal; `readNoteContentForEntry` in the same file keeps its caller and stays.

**`get_similar_notes` candidate filtering**

- From: `filterCandidates` does prefix-exclusion and existence checking in one pass.
- To: prefix-exclusion stays local (it is `exclude_folders` domain logic); existence checking becomes one `entry.filterExisting` call.
- Reason: the two concerns are unrelated — one is a caller-supplied filter, the other a corpus invariant.
- Impact: non-breaking. Exclusion still applies before the existence check, so the observable result set is unchanged.

## Capabilities

### New Capabilities

- `corpus-staleness-filtering`: the guarantee that no path derived from the Smart Connections corpus reaches a client unless it exists on disk at request time — which tools it binds, where the check sits relative to other filtering, and the single per-vault adapter that delivers it.

### Modified Capabilities

<!-- None. `hybrid-search` pins the fused response contract, not where existence checking lives; observable `search_notes` output is unchanged. -->

## Impact

- `src/lib/vault-registry.ts` — `IVaultEntry.filterExisting`, `IVaultEntryDeps.existingPathFilterFactory`, wired in `VaultRegistry.create`.
- `src/lib/obsidian/existing-paths.ts` — new; the dedup + parallel `fs.access` implementation, alongside `vault-conventions.ts`.
- `src/server.ts` — `buildDefaultVaultEntryDeps` supplies the real factory.
- `src/modules/semantic/tools/search-notes.ts`, `find-duplicates.ts`, `get-similar-notes.ts` — private copies deleted, call `entry.filterExisting`.
- `src/modules/semantic/tool-helpers.ts` — `pathExistsForEntry` removed.
- Tests: `test/operations/tools/_test-registry.ts` gains a disk-backed default so existing temp-dir rigs keep working unchanged; existence semantics get asserted once against the adapter instead of three times through three handlers; `test/lib/vault-registry.test.ts` covers the new factory.
- Docs: `docs/architecture/smart-connections-corpus.md` (state the staleness obligation and name its one owner), `docs/architecture/vault-registry.md` (the new per-entry capability). ADR-0006 is not amended — ADRs are immutable (ADR-0008).
- No dependency changes. No breaking contract change.
