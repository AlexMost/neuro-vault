# Vault Scope

The single per-vault definition of "which files are visible" — consulted by every discovery surface so lexical search, structured queries, and vault-wide aggregation can no longer disagree with each other about vault membership.

## What it is

`src/lib/obsidian/vault-scope.ts` defines `VaultScope`:

```typescript
interface VaultScope {
  ignorePatterns: string[];
  isExcluded(relPath: string): boolean;
}

function createVaultScope(input?: {
  gitignoreLines?: string[];
  configExclusions?: string[];
}): VaultScope;

function gitignoreLinesToPatterns(lines: string[]): string[];
```

`createVaultScope` compiles one pattern list from the three exclusion layers below and exposes two views over it — `ignorePatterns` and `isExcluded` — described in [Two views](#two-views-prune-vs-predicate). `src/lib/obsidian/vault-scope-config.ts` builds a `VaultScope` for a real vault: `loadVaultScope(vaultRoot)` reads the vault root's `.gitignore` and `.neuro-vault/config.json` and calls `createVaultScope` with the result. `IVaultEntry.scope` (`src/lib/vault-registry.ts`) holds one `VaultScope` per registered vault, built once at `VaultRegistry.create` time via `IVaultEntryDeps.scopeFactory` — production wires `scopeFactory` to `loadVaultScope` in `buildDefaultVaultEntryDeps` (`src/server.ts`).

## Three exclusion layers, unioned

Scope is the union of three layers — "more entries = fewer visible files", no ordering, no override:

1. **Always excluded, non-configurable.** Any path with a dot-segment (`.obsidian/`, `.smart-env/`, `.git/`, `.neuro-vault/`, `.trash/`, …) is excluded unconditionally; no config entry can re-include one. `isExcluded` checks this directly (`hasDotSegment`); the underlying scan additionally enumerates with fast-glob's `dot: false`, so dot-paths never even reach the pattern match.
2. **Built-in defaults.** `Templates/` (hard-coded, `DEFAULT_EXCLUDED_DIRS`) plus every entry of the vault root's `.gitignore`, translated to patterns by `gitignoreLinesToPatterns` (see the next section).
3. **User config.** `.neuro-vault/config.json`'s `"exclusions"` array, unioned in verbatim as additional globs.

There is no re-include or negation mechanism at any layer: config cannot remove a default exclusion, and a `.gitignore` negation line (`!...`) is simply skipped rather than honoured (see below). This is deliberate (design D2) — union-only keeps the mental model to one direction, and nobody has asked to re-include `Templates/`.

## Gitignore subset

`gitignoreLinesToPatterns` implements a deliberately minimal, deterministic subset of gitignore syntax — not git's actual matching rules:

- Only the vault root's `.gitignore` is read. Nested `.gitignore` files are never consulted.
- Blank lines are skipped.
- Comment lines (starting with `#`) are skipped.
- Negation lines (starting with `!`) are skipped — they have no effect. A line `build/` followed by `!build/keep.md` still excludes `build/keep.md`; the negation is silently ignored.
- Every remaining line is stripped of a leading `/` and a trailing `/`, then expanded to **two** patterns: the entry itself and `<entry>/**`. That pair excludes the named path *and* its entire subtree.
- Every pattern is **anchored at the vault root**. This is the one place this subset diverges most visibly from real gitignore semantics: git matches a slash-less entry like `build` at *any* directory depth, but here `build` only ever means `<vaultRoot>/build`, never `<vaultRoot>/some/nested/build`.

The anchoring choice trades fidelity for predictability (design D4): a vault owner reading their own `.gitignore` gets exactly the paths named, no depth-dependent surprises, at the cost of not matching git's own behavior for unanchored entries. If a vault's `.gitignore` relies on unanchored matching, only the root-level occurrence of that name is honored here.

**Accepted behaviour change:** the live vault's root `.gitignore` names `docs/superpowers/`, which now leaves lexical discovery entirely — that folder was already excluded from the Smart Connections corpus semantically, so this closes a pre-existing membership gap between the two legs rather than opening a new one.

## Config contract and failure behaviour

`.neuro-vault/config.json` (vault-relative; the constant lives as `SCOPE_CONFIG_PATH` in `vault-scope-config.ts`) carries one key:

```json
{ "exclusions": ["Archive/**", "some/other/glob/**"] }
```

`"exclusions"` entries are standard globs (picomatch syntax, `dot: true`), anchored at the vault root like every other layer, unioned with the built-in defaults. Read once per vault, at `VaultRegistry.create` time — the registry already builds entries asynchronously, so the extra file read is free.

Failure handling is deliberately asymmetric between "no config" and "broken config" (design D5):

| Condition | Result |
| --- | --- |
| No `.neuro-vault/config.json` (`ENOENT`) | Silent fallback to built-in defaults. No warning — an unconfigured vault is the common case. |
| File exists but unreadable (permissions, I/O error) | Fallback to defaults + a stderr warning naming the vault root. |
| File exists but is not valid JSON | Fallback to defaults + a stderr warning naming the vault root. |
| File exists, valid JSON, but `"exclusions"` is present and not a `string[]` | Fallback to defaults + a stderr warning naming the vault root. |
| File exists, valid JSON, `"exclusions"` key absent | Fallback to defaults, no warning (an empty/other-purposed config file is not an error). |

The warning always goes to **stderr**, never stdout — stdout is the MCP transport and must stay clean (`LoadVaultScopeOptions.warn` defaults to `console.error`). A bad config in one vault never stops the server from starting or serves any other vault; this follows the `vault-conventions.ts` best-effort precedent (see [`vault-conventions.md`](./vault-conventions.md)), but adds the warning that precedent doesn't have — scope config changes *search membership*, so a typo silently collapsing to `null` would be invisible in a way a missing conventions file is not.

`.gitignore` itself has no failure contract worth naming: a missing `.gitignore` (the common case for a non-git-tracked vault) simply means the built-in-defaults layer is just `Templates/` plus the dot-segment rule, with no warning.

## Two views: prune vs. predicate

`VaultScope` exposes the same compiled pattern list two ways, and they exist for different reasons:

- **`ignorePatterns: string[]`** — the raw pattern list, fed to fast-glob's own `ignore` option during `FsVaultReader.scan`. This is a **traversal prune**: it lets fast-glob skip whole excluded subtrees during enumeration rather than walking them and discarding results afterward. It does not carry the dot-segment rule (fast-glob's `dot: false` already covers that at the enumeration level).
- **`isExcluded(relPath): boolean`** — a picomatch-compiled predicate (`dot: true`) plus the dot-segment check, and it is the **authoritative** membership test. Every path `scan` produces is filtered through it regardless of whether `ignorePatterns` was also passed to fast-glob, so the two views agree on the final result by construction even though only one of them does any of the traversal-time pruning.

**Why prefixed scans rely on the predicate alone.** `FsVaultReader.scan({ pathPrefix })` moves fast-glob's `cwd` into the prefix directory before globbing, so the paths fast-glob sees during matching are relative to the prefix, not the vault root. Root-anchored patterns like `Templates/**` cannot match against those prefix-relative paths — `Templates/` fifteen levels up from `cwd` doesn't look like `Templates/` to a matcher rooted at `cwd`. So `scan` passes `ignore` to fast-glob **only on unprefixed scans** (`!prefix && this.scope ? this.scope.ignorePatterns : []`); a prefixed scan skips the glob-time prune entirely and instead re-prefixes each match back to a vault-relative path (`${prefix}/${match}`) before running it through `scope.isExcluded`. No pattern rewriting is needed — the predicate simply gets paths in the coordinate system it was compiled for.

## What consumes scope

Every discovery surface routes through `FsVaultReader.scan`, so all of them inherited scope-filtered results with **zero code changes of their own** (design D6):

- Lexical search (`LexicalIndex`, the lexical leg of `search_notes`) — see [`lexical-search.md`](./lexical-search.md).
- `query_notes` — see [`query.md`](./query.md).
- Path listing (`listMatchingPaths`, the structural pre-filter shared by `search_notes` and `query_notes`) — see [`retrieval-policy.md`](./retrieval-policy.md).
- Tag and property aggregation (`list_tags` / `list_properties` on `FsVaultProvider`) — see [`vault-provider.md`](./vault-provider.md).
- Vault overview (`get_vault_overview` / `vault://overview`, `total_notes` and folder counts) — see [`vault-conventions.md`](./vault-conventions.md).
- The wikilink graph (`WikilinkGraphIndex.rebuild`, backlink counts) — see [`wikilink-graph.md`](./wikilink-graph.md).
- Note-name resolution (`buildBasenameIndex`, `kind: 'name'` identifiers) — see [`vault-provider.md`](./vault-provider.md).

**From the next slice on:** the own-corpus semantic indexer (queue slice `own-corpus-indexer`) will consult the same `VaultScope` for embedding membership, so the semantic and lexical legs stop being able to diverge on "which notes exist" the way the Smart Connections corpus and the lexical scan could before this change. That work has not shipped yet — this doc names it so the governed-surfaces list stays accurate once it does.

A consequence stated deliberately (design D6): backlink counts, basename→path name resolution, `total_notes`/folder counts, and rank-fusion's adaptive `k` (`N` = the scoped scan length, see [`rank-fusion.md`](./rank-fusion.md)) all shift wherever scope shrinks the visible set. That is the point of one shared definition, not a side effect to work around. A link *to* an excluded note becomes an unresolved wikilink target, exactly like a link to any other non-existent note; an excluded note itself contributes no outgoing edges, because it is never scanned in the first place.

## Discovery, not access control

Scope governs **discovery** — scan, and everything the scan feeds. It is not an ACL. `read_notes` called with an explicit path reads the file regardless of scope membership: a caller who already knows `Templates/Daily.md` exists (because they read the vault's own conventions, or a golden-set fixture path) can still read it directly. This is deliberate (design D7): scope answers "what shows up when discovering", not "what may be read" — those are different capabilities with different threat models, and conflating them would over-promise access control this module does not implement. Config changes are pure membership changes too: no `embed_version` bump, no invalidation step — the next `scan` call (and, once the indexer lands, the next reconcile) simply reflects whatever the current config says.

## What it deliberately does not do

- **No re-include or negation.** Neither `.gitignore` negation lines nor config entries can restore a default-excluded path (design D2, D4). If a future need arises to re-include `Templates/` for one vault, that's a new mechanism, not a use of this one.
- **No nested `.gitignore` support, no gitignore ordering semantics.** Only the root file, only the subset described above.
- **No `excluded_headings` or embed-specific exclusion knobs.** Scope answers *which files*; what part of a file gets embedded (truncation, `min_chars`) is an indexer-side concern layered on top, not scope's job (design D1).
- **Does not reproduce Smart Connections' own exclusion quirks.** The Smart Connections plugin applies its own `file_exclusions` config before writing its corpus, including an implicit `file**`-style prefix match this module does not replicate. One concrete, accepted membership diff: the live vault has a root-level `Untitled.md` that SC's `file_exclusions: "Untitled"` setting excludes from its corpus, but that this scope module does **not** exclude (nothing here names it) — so `Untitled.md` can appear in lexical discovery while remaining absent from semantic results. This is a known, accepted gap (design D3), to be revisited as part of a parity diff against the Smart Connections corpus in a later slice, not fixed here.

## Where the code lives

- `src/lib/obsidian/vault-scope.ts` — `VaultScope`, `createVaultScope`, `gitignoreLinesToPatterns`, the dot-segment rule.
- `src/lib/obsidian/vault-scope-config.ts` — `loadVaultScope`, `SCOPE_CONFIG_PATH`, config parsing and the stderr-warning failure contract.
- `src/lib/obsidian/vault-reader.ts` — `FsVaultReader.scan` consumes `scope.ignorePatterns` (unprefixed scans only) and filters every result through `scope.isExcluded`.
- `src/lib/vault-registry.ts` — `IVaultEntry.scope`, `IVaultEntryDeps.scopeFactory`.
- `src/server.ts` — wires `scopeFactory` to `loadVaultScope` in `buildDefaultVaultEntryDeps`.
