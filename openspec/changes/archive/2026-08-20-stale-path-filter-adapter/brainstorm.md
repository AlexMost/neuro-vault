# Brainstorm — stale-path filter adapter

Raw capture. Source: candidate 4 of the architecture review
(`architecture-review-20260820-124639`, main @ 69adcb5), rated **Strong /
local-substitutable**, verified by an independent agent.

## Background

The Smart Connections corpus is read-only and reloads on an `(max mtime, file
count)` signature over `.ajson` files. It can therefore name a note that is no
longer on disk. Every corpus consumer has to check existence itself before
returning paths, or it returns ghosts.

Today that knowledge is discharged by three private copies:

| Site | Shape |
| --- | --- |
| `src/modules/semantic/tools/search-notes.ts:104` | `buildExistingPathSet(entry, paths)` |
| `src/modules/semantic/tools/find-duplicates.ts:31` | verbatim copy of the same function |
| `src/modules/semantic/tools/get-similar-notes.ts:126` | third variant, interleaved with prefix-exclusion inside `filterCandidates` |

Verified during exploration: copies 1 and 2 are character-identical (same body,
same `pathExistsForEntry` helper, same dedup-then-`Promise.all` structure).
Copy 3 is the same algorithm with `isExcluded` filtering applied first.

Remove any one copy and it has to be rewritten — the deletion test fails.
Knowledge reappearing at N=3 call sites is the signature of a missing module.

## Decision chain

**Q1 — Where does the single filter live?**
Three options weighed:

- *(a) On `IVaultEntry`*, built by an `existingPathFilterFactory` in
  `IVaultEntryDeps` — the pattern `readConventions` / `conventionsReaderFactory`
  already proved in this repo.
- *(b) Shared free function* exported once from
  `src/modules/semantic/tool-helpers.ts`. Smallest diff, no `IVaultEntry`
  change, no test-rig churn — but it stays a semantic-module helper, hits disk
  directly, and is not injectable, so tests keep needing real temp directories.
- *(c) Free function in `src/lib/obsidian/`* — module-neutral, but still not
  injectable and not discoverable from the entry.

**Chosen: (a).** It is the only option that makes the filter injectable (one
fake replaces three temp-dir rigs), discoverable (a future tool author sees it
on the entry they already hold), and consistent with the existing per-entry
capability pattern.

**Q2 — What shape does it return?**
`(paths: Iterable<string>) => Promise<Set<string>>` — the set of input paths
that still exist. Rejected a generic `filterExistingBy<T>(items, getPath)`
because the set is what all three sites actually need and the generic form
serves none of them better:

- `find_duplicates` tests two paths per pair (`note_a` AND `note_b`) — needs
  membership queries, not a filtered list.
- `search_notes` tests seeds **and** each seed's `related[]` against the same
  set — one set, two consumers.
- `get_similar_notes` filters a candidate list — `Set.has` serves it fine.

All three sites pass note paths only; expansion candidates come from
`flattenExpansion`, which emits `rel.path` (note paths, never block keys), so
no fragment handling is needed.

**Q3 — Does `get_similar_notes` come along, given its copy is interleaved?**
Yes. Split `filterCandidates` into prefix-exclusion (stays local — it is
domain logic about `exclude_folders`, not corpus staleness) plus one
`entry.filterExisting` call. Leaving it out would keep the concept implemented
twice and fail the change's own premise; N=3 is the reason the module is
missing at all.

**Q4 — What happens to `pathExistsForEntry`?**
After all three sites move, it has no callers and gets deleted from
`src/modules/semantic/tool-helpers.ts`. That deletion is the deletion test
passing: the concept lives in exactly one place afterwards.
`readNoteContentForEntry` in the same file keeps its caller
(`get-similar-notes` forward-link resolution) and stays.

**Q5 — Ship standalone, or ride along with candidate 1?**
The review suggests riding along with candidate 1 (`unify-retrieval-pipeline`).
Rejected: that change is currently an empty scaffold with zero artifacts.
Landing this one first is strictly better — candidate 1's unified pipeline then
inherits one filter instead of collapsing two.

**Q6 — How do existing test rigs survive an added required field on `IVaultEntry`?**
`makeTestRegistry` (`test/operations/tools/_test-registry.ts`) already defaults
`semanticAvailable`, `reader`, and `readConventions` on `Partial<IVaultEntry>`
inputs. Add a `filterExisting` default bound to the partial entry's `path`, so
every temp-dir rig (`makeSearchDeps`, the `find-duplicates` fixture, the
`get-similar-notes` rig) keeps working with a zero-line diff. Suites that want
staleness without touching disk inject a fake instead.

## Design trade-offs accepted

- **`IVaultEntry` grows one field.** Accepted: it is the interface every tool
  handler already holds, and the alternative is three copies that drift.
- **Existence checking stays at the handler seam.** The retrieval policy layer
  stays pure (no disk I/O); handlers call `entry.filterExisting` exactly where
  `buildExistingPathSet` was called. No behaviour moves across a layer.
- **`existingPathFilterFactory` is a required dep**, not optional, matching
  `conventionsReaderFactory`. `buildDefaultVaultEntryDeps` supplies the real
  one; the two `test/server-modules.test.ts` override sites do not need to
  touch it (they override only what they fake).

## Correction to the review's framing

The review states ADR-0006 "makes existence-checking a permanent obligation of
every corpus consumer." ADR-0006 does not say that in those words — it records
the corpus as read-only and note bodies as read on demand. The obligation is a
real *consequence* of that decision, not a stated clause. This change writes it
as a consequence and adds the missing sentence to
`docs/architecture/smart-connections-corpus.md`; it does not amend ADR-0006
(ADRs are immutable per ADR-0008).

## Out of scope

- Candidate 1 (fold `executeRetrieval` into the multi-query pipeline) — its own
  change, `unify-retrieval-pipeline`.
- Candidate 5 (leg reports) — the review sequences it *after* 1 and 4.
- Any change to what the three tools return for notes that DO exist. This is a
  pure structural move; observable MCP behaviour is unchanged.
