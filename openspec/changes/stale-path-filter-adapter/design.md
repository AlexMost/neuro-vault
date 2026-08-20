## Context

Semantic tools read paths out of a Smart Connections corpus that the server never writes and does not watch. The corpus reloads on an `(max mtime, file count)` signature over `.ajson` files, so between a note's deletion on disk and the plugin's next index write, the corpus still names it. Every tool that returns corpus-derived paths therefore has to check the filesystem before answering, or it returns paths a client cannot open.

At HEAD that check exists three times:

| Site | Form |
| --- | --- |
| `src/modules/semantic/tools/search-notes.ts:104` | `buildExistingPathSet(entry, paths)` |
| `src/modules/semantic/tools/find-duplicates.ts:31` | character-identical copy |
| `src/modules/semantic/tools/get-similar-notes.ts:126` | same algorithm, interleaved with `exclude_folders` prefix filtering inside `filterCandidates` |

All three route through `pathExistsForEntry` in `src/modules/semantic/tool-helpers.ts`, and all three re-implement the same dedup → parallel `fs.access` → survivor-set structure around it. The tests mirror the duplication: `makeSearchDeps` builds a temp vault for `search_notes`, and `find-duplicates` and `get-similar-notes` each carry their own ad-hoc temp-directory rig for the same assertion.

Constraints this design works inside:

- `IVaultEntry` is the object every tool handler already holds; per-entry capabilities are constructed by factories in `IVaultEntryDeps` (`readerFactory`, `conventionsReaderFactory`, …) and assembled in `VaultRegistry.create`.
- The retrieval policy layer (`retrieval-policy.ts`) is pure — no disk I/O. Existence checking lives at the handler seam and must stay there.
- Strict TypeScript; `npx tsc --noEmit` is authoritative (ADR-0002).

## Goals / Non-Goals

**Goals:**

- One implementation of corpus-staleness filtering, reachable from any vault entry.
- Existence semantics — dedup, per-path independence, what "exists" means — asserted once, against the adapter, not three times through three tool handlers.
- A fourth corpus-reading tool is staleness-safe by construction: the capability is visible on the entry it already holds.
- Zero observable change for clients: the three tools return exactly what they return today.

**Non-Goals:**

- Making the corpus itself staleness-aware (watching the vault, invalidating entries). ADR-0006 keeps the corpus read-only; this change filters at the seam, it does not move the problem upstream.
- Caching existence results across requests. Each request checks disk, as today.
- Candidate 1 (`unify-retrieval-pipeline`) or candidate 5 (leg reports) from the same review.
- Extending existence filtering to operations tools, which read from disk directly and are existence-safe by construction (ADR-0009).

## Decisions

### D1 — The filter is a per-entry capability, not a shared function

- **Choice**: `IVaultEntry.filterExisting: (paths: Iterable<string>) => Promise<Set<string>>`, produced by `IVaultEntryDeps.existingPathFilterFactory: (opts: { vaultRoot: string }) => …` and assembled in `VaultRegistry.create` — the same shape as `readConventions` / `conventionsReaderFactory`.
- **Rationale**: it is the only form that is simultaneously injectable (tests replace one function instead of provisioning three temp directories), discoverable (the next tool author sees it on the entry in hand), and already idiomatic here.
- **Alternatives considered**:
  - *Export `buildExistingPathSet` once from `src/modules/semantic/tool-helpers.ts`.* Smallest diff and no `IVaultEntry` change, but it stays a semantic-module helper that reaches for the disk itself — not injectable, so every test still needs real files, and invisible to a future operations-side consumer.
  - *A free `filterExistingPaths(vaultRoot, paths)` in `src/lib/obsidian/`.* Module-neutral, but still not injectable and still not discoverable from the entry; it would leave `vaultRoot` threading at each call site.

### D2 — The return value is a `Set` of survivors, not a filtered list

- **Choice**: `(paths) => Promise<Set<string>>`.
- **Rationale**: membership is what the call sites need. `find_duplicates` tests two paths per pair; `search_notes` tests seeds *and* each seed's `related[]` against one set; `get_similar_notes` filters a candidate list with `Set.has`. A set serves all three without any of them reshaping their data first.
- **Alternatives considered**: a generic `filterExistingBy<T>(items, getPath) => Promise<T[]>`. It reads well for `get_similar_notes` alone and serves neither of the other two — `find_duplicates` would need two passes or a composite key, `search_notes` would need two calls for seeds and expansions.

### D3 — Input is note paths only; no fragment handling

- **Choice**: the adapter treats every input as a vault-relative note path and joins it to the vault root.
- **Rationale**: verified against the call sites — `search_notes` passes `node.path` plus `flattenExpansion(...)` output, and `flattenExpansion` emits `rel.path` (note paths, never block keys); `find_duplicates` passes `note_a` / `note_b`; `get_similar_notes` passes `candidate.path`. No site passes a `#`-fragment key.
- **Alternatives considered**: stripping a `#…` suffix defensively. Rejected — no caller produces one, and silently accepting block keys would make the adapter's contract vaguer than the thing it replaces.

### D4 — `get_similar_notes` splits exclusion from existence

- **Choice**: `filterCandidates` keeps `exclude_folders` prefix filtering locally and delegates the existence pass to `entry.filterExisting`. Exclusion runs first, as today.
- **Rationale**: the two filters answer different questions — one is a caller-supplied preference, the other a corpus invariant. Order is preserved deliberately: excluding first means fewer `fs.access` calls, and since neither filter can resurrect a candidate the other dropped, the result set is identical either way.
- **Alternatives considered**: leaving `get_similar_notes` untouched as the one non-mechanical edit. Rejected — with it excluded, the concept still lives in two places and the change fails its own premise.

### D5 — `pathExistsForEntry` is deleted

- **Choice**: remove it from `src/modules/semantic/tool-helpers.ts` once the three call sites move.
- **Rationale**: it has no remaining callers, and an exported single-path existence check is exactly the seed a fourth private copy grows from. `readNoteContentForEntry` in the same file keeps its caller (forward-link resolution in `get_similar_notes`) and stays.
- **Alternatives considered**: keeping it as the adapter's own internal helper. Rejected — the adapter lives in `src/lib/obsidian/`, and a one-line `fs.access` wrapper does not need to be shared across module boundaries to be used once.

### D6 — Test rigs get a disk-backed default, not a rewrite

- **Choice**: `makeTestRegistry` defaults `filterExisting` to a real filesystem filter bound to the partial entry's `path`, next to its existing `semanticAvailable` / `reader` / `readConventions` defaults.
- **Rationale**: every current rig provisions a real temp vault and expects real existence semantics. A disk-backed default keeps all of them passing with no diff, while suites that want staleness without touching disk inject a fake set instead.
- **Alternatives considered**: defaulting to "everything exists". Rejected — it would silently disable the very filter under test in the three suites that currently assert it.

### D7 — Ship standalone, ahead of `unify-retrieval-pipeline`

- **Choice**: its own change and its own PR.
- **Rationale**: the review suggests folding it into candidate 1, but that change is an empty scaffold with zero artifacts. Landing this first is strictly better — candidate 1 then unifies one pipeline that already has one filter, instead of collapsing two filters as a side effect.

### D8 — No ADR; the staleness obligation is recorded as a consequence

- **Choice**: no new ADR. `docs/architecture/smart-connections-corpus.md` gains the obligation and names its owner; `docs/architecture/vault-registry.md` gains the new per-entry capability.
- **Rationale**: no new dependency, no core invariant overturned, no close call between competing runtimes — this refines how an existing ADR-0006 consequence is discharged. The review's framing that ADR-0006 "makes existence-checking a permanent obligation of every corpus consumer" is a fair reading of its consequences but is not a clause in the ADR, and ADRs are immutable (ADR-0008), so the sentence belongs in the living architecture doc.

## Risks / Trade-offs

- [Risk] Adding a required field to `IVaultEntry` breaks every object literal that builds one. → Mitigation: production builds entries only in `VaultRegistry.create`; tests build them through `makeTestRegistry`, which casts from `Partial<IVaultEntry>` and gains the default in D6. `npx tsc --noEmit` catches any site both miss.
- [Risk] A behaviour drift slips in while rewriting `get_similar_notes`'s interleaved copy — the one non-mechanical edit. → Mitigation: preserve exclusion-before-existence ordering explicitly, and land the existing `get-similar-notes` staleness test unchanged as the regression guard before touching the function.
- [Trade-off] `IVaultEntry` grows a fourth per-entry capability, so the interface every handler holds gets slightly wider. → Accepted: the alternative is three copies that already exist and will drift; a named capability on the entry is how this repo has chosen to express per-vault behaviour.
- [Trade-off] `existingPathFilterFactory` is required rather than optional in `IVaultEntryDeps`. → Accepted: it matches `conventionsReaderFactory`, and the two partial-override sites in `test/server-modules.test.ts` override only the factories they fake, so neither needs to supply it.

## Migration Plan

Pure internal refactor — no deployment step, no data migration, no config change. Sequencing within the PR:

1. Adapter + registry wiring + server wiring, with its own tests, while the three private copies still stand. Nothing observable changes; `npm test` passes on the unchanged call sites.
2. `makeTestRegistry` default, so existing rigs keep passing.
3. Move the three call sites one at a time, running the suite after each.
4. Delete `pathExistsForEntry`; `npx tsc --noEmit` proves no caller remains.
5. Docs sweep across all of `docs/`, not just the architecture layer.

Rollback: revert the commit. No state outside the repo is touched, and no client-visible contract moved, so a revert needs no coordination and no release note beyond the changelog entry.

Acceptance: `npm test`, `npm run lint`, and `npx tsc --noEmit` all pass; the three tools' observable output is unchanged; `grep` finds exactly one existence-filter implementation in `src/`.

## Open Questions

None blocking. One deliberately deferred: whether `filterExisting` eventually belongs to a broader "vault filesystem view" alongside `readConventions` and `readNoteContentForEntry`. Deciding that needs a second consumer outside the semantic module, which this change does not create.
