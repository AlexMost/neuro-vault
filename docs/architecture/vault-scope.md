# Vault Scope

The single per-vault definition of "which files are visible" — consulted by every discovery surface so lexical search, structured queries, and vault-wide aggregation can no longer disagree with each other about vault membership.

## What it is

`src/lib/obsidian/vault-scope.ts` defines `VaultScope`:

```typescript
interface VaultScope {
  ignorePatterns: string[];
  isExcluded(relPath: string): boolean;
  isSubtreeExcluded(relDir: string): boolean;
}

function createVaultScope(input?: {
  gitignoreLines?: string[];
  configExclusions?: string[];
}): VaultScope;

function gitignoreLinesToPatterns(lines: string[]): string[];
function configExclusionsToPatterns(entries: string[]): string[];
```

`createVaultScope` compiles one pattern list from the three exclusion layers below and exposes three views over it — `ignorePatterns`, `isExcluded` and `isSubtreeExcluded` — described in [Two views](#two-views-prune-vs-predicate) and [The watcher](#the-watcher-prune-vs-filter). `src/lib/obsidian/vault-scope-config.ts` builds a `VaultScope` for a real vault: `loadVaultScope(vaultRoot)` reads the vault root's `.gitignore` and `.neuro-vault/config.json` and calls `createVaultScope` with the result. `IVaultEntry.scope` (`src/lib/vault-registry.ts`) holds one `VaultScope` per registered vault, built once at `VaultRegistry.create` time via `IVaultEntryDeps.scopeFactory` — production wires `scopeFactory` to `loadVaultScope` in `buildDefaultVaultEntryDeps` (`src/server.ts`).

## Three exclusion layers, unioned

Scope is the union of three layers — "more entries = fewer visible files", no ordering, no override:

1. **Always excluded, non-configurable.** Any path with a dot-segment (`.obsidian/`, `.smart-env/`, `.git/`, `.neuro-vault/`, `.trash/`, …) is excluded unconditionally; no config entry can re-include one. `isExcluded` checks this directly (`hasDotSegment`); the underlying scan additionally enumerates with fast-glob's `dot: false`, so dot-paths never even reach the pattern match.
2. **Built-in defaults.** `Templates/` (hard-coded, `DEFAULT_EXCLUDED_DIRS`) plus every entry of the vault root's `.gitignore`, translated to patterns by `gitignoreLinesToPatterns` (see the next section).
3. **User config.** `.neuro-vault/config.json`'s `"exclusions"` array, unioned in as additional globs, with path-naming entries expanded to their subtree by `configExclusionsToPatterns` (see [Config entries that name a path](#config-entries-that-name-a-path)).

There is no re-include or negation mechanism at any layer: config cannot remove a default exclusion, and a `.gitignore` negation line (`!...`) is simply skipped rather than honoured (see below). This is deliberate (design D2) — union-only keeps the mental model to one direction, and nobody has asked to re-include `Templates/`.

## Gitignore subset

`gitignoreLinesToPatterns` implements a deliberately minimal, deterministic subset of gitignore syntax — not git's actual matching rules:

- Only the vault root's `.gitignore` is read. Nested `.gitignore` files are never consulted.
- Blank lines are skipped.
- Comment lines (starting with `#`) are skipped.
- Negation lines (starting with `!`) are skipped — they have no effect. A line `build/` followed by `!build/keep.md` still excludes `build/keep.md`; the negation is silently ignored.
- Every remaining line is stripped of a leading `/` and a trailing `/`, then expanded to **two** patterns: the entry itself and `<entry>/**`. That pair excludes the named path *and* its entire subtree.
- Matching is **case-sensitive**, including on a case-insensitive macOS volume. `Templates` (the built-in default) excludes `Templates/Daily.md` but not `templates/Daily.md`; a `.gitignore` line `Build/` does not exclude `build/`. Name the directory exactly as it appears on disk.
- Every pattern is **anchored at the vault root**. This is the one place this subset diverges most visibly from real gitignore semantics: git matches a slash-less entry like `build` at *any* directory depth, but here `build` only ever means `<vaultRoot>/build`, never `<vaultRoot>/some/nested/build`.

The anchoring choice trades fidelity for predictability (design D4): a vault owner reading their own `.gitignore` gets exactly the paths named, no depth-dependent surprises, at the cost of not matching git's own behavior for unanchored entries. If a vault's `.gitignore` relies on unanchored matching, only the root-level occurrence of that name is honored here.

**Hazard — an allowlist-style `.gitignore` blanks the vault.** The common idiom

```gitignore
*
!Notes/
```

does not work here. `*` is honoured (it compiles to `['*', '*/**']`, which matches every path at every depth) but the `!Notes/` line that would rescue the allowed subtree is a negation line, and negation lines are skipped. The result is a scope that excludes everything: discovery returns nothing at all. Since this is indistinguishable from an empty vault at the tool surface, `createVaultScope` emits one stderr warning when a root `.gitignore` line names the whole vault (`*`, `**`, or `/`). If your vault's `.gitignore` is allowlist-shaped, express the exclusions positively instead — list the folders you want out, or move them into `.neuro-vault/config.json`'s `"exclusions"`.

**Accepted behaviour change:** any folder a vault's root `.gitignore` already names now leaves lexical discovery entirely. Since the server's own corpus is built from this same scoped scan (see below), the two legs already agree on membership here — but a vault that gitignores content it still expects to search will see that content disappear from search, `query_notes`, tag and property listings, overview counts, backlink counts, and name resolution. `read_notes` by explicit path is unaffected.

## Config contract and failure behaviour

`.neuro-vault/config.json` (vault-relative; the constant lives as `SCOPE_CONFIG_PATH` in `vault-scope-config.ts`) carries one key:

```json
{ "exclusions": ["Archive/**", "some/other/glob/**"] }
```

`"exclusions"` entries are standard globs (picomatch syntax, `dot: true`), anchored at the vault root like every other layer, unioned with the built-in defaults. An entry that names a path rather than a file glob (`Archive`, `**/drafts`) excludes that path's whole subtree — see the next section. Read once per vault, at `VaultRegistry.create` time — the registry already builds entries asynchronously, so the extra file read is free.

### Config entries that name a path

A config entry whose last segment has no `*` — `Archive`, `a/b`, `**/drafts`, `Archive/` — is expanded by `configExclusionsToPatterns` to the entry plus `<entry>/**` (a trailing `/` is stripped first), exactly like a `.gitignore` entry. So a bare `Archive` excludes `Archive/a.md` and everything deeper, as the owner expects, and `**/drafts` excludes a `drafts` folder at any depth. An entry whose last segment contains a wildcard is a glob over files and is kept verbatim: `Archive/**`, `**/*.excalidraw.md`, `*.md`, and `Archive/*` (direct children only) mean exactly what picomatch says.

The expansion is not cosmetic. Without it a bare `Archive` compiles to a picomatch pattern that matches the path `Archive` but not `Archive/a.md`, so `isExcluded` would report the files in scope; yet fast-glob's `ignore` prunes any directory whose ignore pattern ends in a static name, so the same entry made `scan` skip the subtree. The two views disagreed, and because the predicate is only a post-filter it cannot bring pruned files back — the notes were in scope on paper and undiscoverable in practice. Expanding the entry makes both views say the same thing, which keeps the invariant in [Two views](#two-views-prune-vs-predicate): the pattern list is never stronger than the predicate.

Failure handling is deliberately asymmetric between "no config" and "broken config" (design D5):

| Condition | Result |
| --- | --- |
| No `.neuro-vault/config.json` (`ENOENT`) | Silent fallback to built-in defaults. No warning — an unconfigured vault is the common case. |
| File exists but unreadable (permissions, I/O error) | Fallback to defaults + a stderr warning naming the vault root. |
| File exists but is not valid JSON | Fallback to defaults + a stderr warning naming the vault root. |
| Valid JSON, but not a JSON object (`null`, `[…]`, `"glob"`, `42`) | Fallback to defaults + a distinct stderr "must be a JSON object with an `exclusions` array" warning. A bare array of globs is the natural mis-write of this format; it must not look like "no config". |
| File exists, valid JSON object, but `"exclusions"` is present and not a `string[]` | Fallback to defaults + a stderr warning naming the vault root. |
| `"exclusions"` is a `string[]` containing an empty entry or one starting with `!` | Those entries are dropped + a stderr warning naming them; the remaining valid entries still apply. |
| File exists, valid JSON, `"exclusions"` key absent | Fallback to defaults, no warning (an empty/other-purposed config file is not an error). |

The warning always goes to **stderr**, never stdout — stdout is the MCP transport and must stay clean (`LoadVaultScopeOptions.warn` defaults to `console.error`). A bad config in one vault never stops the server from starting or serves any other vault; this follows the `vault-conventions.ts` best-effort precedent (see [`vault-conventions.md`](./vault-conventions.md)), but adds the warning that precedent doesn't have — scope config changes *search membership*, so a typo silently collapsing to `null` would be invisible in a way a missing conventions file is not.

`.gitignore` follows the same asymmetry. A **missing** `.gitignore` (the common case for a non-git-tracked vault) simply means the built-in-defaults layer is just `Templates/` plus the dot-segment rule, silently. A `.gitignore` that exists but cannot be read (permissions, I/O error) gets a stderr warning like the config does: that failure silently *widens* scope, which is exactly the kind of invisible membership shift D5 exists to surface.

## Two views: prune vs. predicate

`VaultScope` exposes the same compiled pattern list two ways, and they exist for different reasons:

- **`ignorePatterns: string[]`** — the raw pattern list, fed to fast-glob's own `ignore` option during `FsVaultReader.scan`. This is a **traversal prune**: it lets fast-glob skip whole excluded subtrees during enumeration rather than walking them and discarding results afterward. It does not carry the dot-segment rule (fast-glob's `dot: false` already covers that at the enumeration level).
- **`isExcluded(relPath): boolean`** — a picomatch-compiled predicate (`dot: true`) plus the dot-segment check, and it is the **authoritative** membership test. Every path `scan` produces is filtered through it regardless of whether `ignorePatterns` was also passed to fast-glob.

The two views are **not** the same matcher: `ignorePatterns` goes to fast-glob's own `ignore`, which resolves through `micromatch`'s nested picomatch copy at a different major version than the direct `picomatch` dependency the predicate is compiled with. What makes them agree on the final result is the ordering, not a shared engine — the predicate post-filter runs **last** over everything the glob returned, and `ignorePatterns` is never *stronger* than `isExcluded` (it is the same list minus the dot rule, which enumeration covers via `dot: false`). So `ignorePatterns` can only ever remove paths the predicate would have removed anyway; it is a traversal-cost optimisation, and the predicate decides membership. That is also why the pattern list is frozen and typed `readonly string[]`: mutating it would break the "never stronger" invariant the agreement rests on.

This is also why a pattern starting with `!` can never enter the list. picomatch treats a leading `!` as its own negation operator — a single `"!Keep/**"` entry would invert the entire predicate — while fast-glob's `ignore` reads the same string the other way round. Such entries are rejected at the config parse boundary (with a warning naming the entry) and again inside `createVaultScope`, along with empty entries, which make picomatch throw outright. `createVaultScope` never throws: a bad entry in one vault's config must not take a multi-vault server down.

**Why prefixed scans rely on the predicate alone.** `FsVaultReader.scan({ pathPrefix })` moves fast-glob's `cwd` into the prefix directory before globbing, so the paths fast-glob sees during matching are relative to the prefix, not the vault root. Root-anchored patterns like `Templates/**` cannot match against those prefix-relative paths — `Templates/` fifteen levels up from `cwd` doesn't look like `Templates/` to a matcher rooted at `cwd`. So `scan` passes `ignore` to fast-glob **only on unprefixed scans** (`!prefix && this.scope ? this.scope.ignorePatterns : []`); a prefixed scan skips the glob-time prune entirely and instead re-prefixes each match back to a vault-relative path (`${prefix}/${match}`) before running it through `scope.isExcluded`. No pattern rewriting is needed — the predicate simply gets paths in the coordinate system it was compiled for.

## The watcher: prune vs. filter

The same two questions — which subtrees may be skipped, which paths count — come up again in the vault entry's file watcher ([`vault-entry.md`](./vault-entry.md#the-watcher-follows-the-scope)), and the watcher used to answer them with a rule of its own (`.md` only, every dot-path ignored), so a note under `Archive/**` still woke the reconcile loop (#106). It now asks the scope, through a third view:

- **`isSubtreeExcluded(relDir): boolean`** — a *sound-but-incomplete* prune test for a vault-relative directory: true only when **every descendant** is excluded, so a watcher may skip the subtree. It is true for a path with a dot segment, and for a directory that matches the prefix of a pattern ending in `/**` (the prefixes are compiled once from `ignorePatterns`, each as the prefix itself and `<prefix>/**`; a bare `/**` has an empty prefix and is dropped). The vault root, `''`, is never excluded. A false answer says nothing.

A pattern of any other shape never prunes: `Archive/*` excludes the files directly under `Archive` but leaves `Archive/2024/note.md` in scope, and `Archive*` matches the directory name itself but none of its descendants, so `isExcluded('Archive')` is true while the subtree must still be watched. This is why the watcher cannot hand `isExcluded` to chokidar as its `ignored` predicate — chokidar 4 drops a whole subtree once `ignored` is true for its directory, and its `stats` argument is unreliable, so a directory cannot be told from a file there. Since a bare `.gitignore` or config entry expands to `X` plus `X/**` ([`.gitignore`](#gitignore-subset), [config](#config-entries-that-name-a-path)), it prunes.

The watcher (`src/lib/vault-entry/watcher.ts`) therefore uses each view for what it is good at:

| Question | Asked of | Answer |
| --- | --- | --- |
| Skip this directory (and everything below)? chokidar's `ignored`, for a directory or a file | `isSubtreeExcluded(rel)` | only when provably all excluded |
| Does this event count? | `path.endsWith('.md') && !isExcluded(rel)` | authoritative, per file |

`rel` is `relative(vaultRoot, p)` with separators turned into `/`, judged against the vault root and not the absolute path, so a vault under a dot-directory (`~/.sync/vault`) is not blinded and a Windows-style input gives the same answer as a POSIX one. The vault root itself has an empty `rel` and is never pruned. The dot rule is what keeps the server's own writes under `.neuro-vault/corpus/` from feeding the watcher back into itself. The old `.tmp` clause is gone: it never matched a `.md` file.

## What consumes scope

Every discovery surface routes through `FsVaultReader.scan`, so all of them inherited scope-filtered results with **zero code changes of their own** (design D6):

- Lexical search (`LexicalIndex`, the lexical leg of `search_notes`) — see [`lexical-search.md`](./lexical-search.md).
- `query_notes` — see [`query.md`](./query.md).
- Path listing (`listMatchingPaths`, the structural pre-filter shared by `search_notes` and `query_notes`) — see [`retrieval-policy.md`](./retrieval-policy.md).
- Tag and property aggregation (`list_tags` / `list_properties` on `FsVaultProvider`) — see [`vault-provider.md`](./vault-provider.md).
- Vault overview (`get_vault_overview` / `vault://overview`, `total_notes` and folder counts) — no dedicated concept doc; the counts come straight from the scoped scan (`src/lib/obsidian/vault-overview.ts`).
- The wikilink graph (`WikilinkGraphIndex.rebuild`, backlink counts) — see [`wikilink-graph.md`](./wikilink-graph.md).
- Note-name resolution (`buildBasenameIndex`, `kind: 'name'` identifiers) — see [`vault-provider.md`](./vault-provider.md).

**Also governed — the server's own embedding corpus.** The indexer takes its path set from the scoped scan and applies no exclusion rule of its own, so a note the scope hides is never embedded and a shard left behind by a scope change is deleted on the next reconcile — see [`own-corpus.md`](./own-corpus.md). Embedding-side rules decide only *what text of an included note* is embedded (the `min_chars` gate, the character truncation), never which notes are included. This is also what the semantic leg of `search_notes`, `get_similar_notes`, and `find_duplicates` serve from — `entry.backend`'s corpus, not a plugin's — so a note the scope hides is absent from `semantic` matches exactly as it is from `lexical` matches, tag counts, and `total_notes`. There is no remaining membership gap between the two legs. The daemon's vault entry applies the scope to every read of its corpora as well ([`vault-entry.md`](./vault-entry.md#reads-the-excluded-path-fold)), because the corpus on disk agrees with the scope only after a pass has swept.

A consequence stated deliberately (design D6): backlink counts, basename→path name resolution, `total_notes`/folder counts, and rank-fusion's adaptive `k` (`N` = the scoped scan length, see [`rank-fusion.md`](./rank-fusion.md)) all shift wherever scope shrinks the visible set. That is the point of one shared definition, not a side effect to work around. A link *to* an excluded note becomes an unresolved wikilink target, exactly like a link to any other non-existent note; an excluded note itself contributes no outgoing edges, because it is never scanned in the first place.

## Discovery, not access control

Scope governs **discovery** — scan, and everything the scan feeds. It is not an ACL. `read_notes` called with an explicit path reads the file regardless of scope membership: a caller who already knows `Templates/Daily.md` exists (because they read the vault's own conventions, or a golden-set fixture path) can still read it directly. This is deliberate (design D7): scope answers "what shows up when discovering", not "what may be read" — those are different capabilities with different threat models, and conflating them would over-promise access control this module does not implement. Config changes are pure membership changes too: no `embed_version` bump, no invalidation step — the next `scan` call, and the next corpus reconcile, simply reflect whatever the current config says.

## What it deliberately does not do

- **No re-include or negation.** Neither `.gitignore` negation lines nor config entries can restore a default-excluded path (design D2, D4). If a future need arises to re-include `Templates/` for one vault, that's a new mechanism, not a use of this one.
- **No nested `.gitignore` support, no gitignore ordering semantics.** Only the root file, only the subset described above.
- **No `excluded_headings` or embed-specific exclusion knobs.** Scope answers *which files*; what part of a file gets embedded (truncation, `min_chars`) is an indexer-side concern layered on top, not scope's job (design D1).

## Where the code lives

- `src/lib/obsidian/vault-scope.ts` — `VaultScope`, `createVaultScope`, `gitignoreLinesToPatterns`, the dot-segment rule, `isSubtreeExcluded`.
- `src/lib/vault-entry/watcher.ts` — `isPrunedDir` (the prune question) and `isWatchedNote` (the filter question) over a scope.
- `src/lib/obsidian/vault-scope-config.ts` — `loadVaultScope`, `SCOPE_CONFIG_PATH`, config parsing and the stderr-warning failure contract.
- `src/lib/obsidian/vault-reader.ts` — `FsVaultReader.scan` consumes `scope.ignorePatterns` (unprefixed scans only) and filters every result through `scope.isExcluded`.
- `src/lib/vault-registry.ts` — `IVaultEntry.scope`, `IVaultEntryDeps.scopeFactory`.
- `src/server.ts` — wires `scopeFactory` to `loadVaultScope` in `buildDefaultVaultEntryDeps`.
