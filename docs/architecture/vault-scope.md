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
- Matching is **case-sensitive**, including on a case-insensitive macOS volume. `Templates` (the built-in default) excludes `Templates/Daily.md` but not `templates/Daily.md`; a `.gitignore` line `Build/` does not exclude `build/`. Name the directory exactly as it appears on disk.
- Every pattern is **anchored at the vault root**. This is the one place this subset diverges most visibly from real gitignore semantics: git matches a slash-less entry like `build` at *any* directory depth, but here `build` only ever means `<vaultRoot>/build`, never `<vaultRoot>/some/nested/build`.

The anchoring choice trades fidelity for predictability (design D4): a vault owner reading their own `.gitignore` gets exactly the paths named, no depth-dependent surprises, at the cost of not matching git's own behavior for unanchored entries. If a vault's `.gitignore` relies on unanchored matching, only the root-level occurrence of that name is honored here.

**Hazard — an allowlist-style `.gitignore` blanks the vault.** The common idiom

```gitignore
*
!Notes/
```

does not work here. `*` is honoured (it compiles to `['*', '*/**']`, which matches every path at every depth) but the `!Notes/` line that would rescue the allowed subtree is a negation line, and negation lines are skipped. The result is a scope that excludes everything: discovery returns nothing at all. Since this is indistinguishable from an empty vault at the tool surface, `createVaultScope` emits one stderr warning when a root `.gitignore` line names the whole vault (`*`, `**`, or `/`). If your vault's `.gitignore` is allowlist-shaped, express the exclusions positively instead — list the folders you want out, or move them into `.neuro-vault/config.json`'s `"exclusions"`.

**Accepted behaviour change:** any folder a vault's root `.gitignore` already names now leaves lexical discovery entirely. In practice such folders were already outside the Smart Connections corpus, so this closes a pre-existing membership gap between the two legs rather than opening a new one — but a vault that gitignores content it still expects to search will see that content disappear from search, `query_notes`, tag and property listings, overview counts, backlink counts, and name resolution. `read_notes` by explicit path is unaffected.

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

## What consumes scope

Every discovery surface routes through `FsVaultReader.scan`, so all of them inherited scope-filtered results with **zero code changes of their own** (design D6):

- Lexical search (`LexicalIndex`, the lexical leg of `search_notes`) — see [`lexical-search.md`](./lexical-search.md).
- `query_notes` — see [`query.md`](./query.md).
- Path listing (`listMatchingPaths`, the structural pre-filter shared by `search_notes` and `query_notes`) — see [`retrieval-policy.md`](./retrieval-policy.md).
- Tag and property aggregation (`list_tags` / `list_properties` on `FsVaultProvider`) — see [`vault-provider.md`](./vault-provider.md).
- Vault overview (`get_vault_overview` / `vault://overview`, `total_notes` and folder counts) — no dedicated concept doc; the counts come straight from the scoped scan (`src/lib/obsidian/vault-overview.ts`).
- The wikilink graph (`WikilinkGraphIndex.rebuild`, backlink counts) — see [`wikilink-graph.md`](./wikilink-graph.md).
- Note-name resolution (`buildBasenameIndex`, `kind: 'name'` identifiers) — see [`vault-provider.md`](./vault-provider.md).

**Not governed yet — the semantic leg.** Everything that reads `entry.corpus` (the Smart Connections AJSON) is *outside* this list: the semantic leg of `search_notes`, `get_similar_notes`, and `find_duplicates`. Scope has no say over their membership in this slice, so a `Templates/` note that Smart Connections happened to embed still comes back under `semantic_matches` even though the same note is absent from `lexical_matches`, tag counts, and `total_notes`. Membership for those tools is whatever the Smart Connections plugin's own `file_exclusions` config produced when it wrote the corpus.

**From the next slice on:** the own-corpus semantic indexer (queue slice `own-corpus-indexer`) will consult the same `VaultScope` for embedding membership, closing exactly that gap — the semantic and lexical legs stop being able to diverge on "which notes exist" the way the Smart Connections corpus and the lexical scan can today. That work has not shipped yet; this doc names it so the governed-surfaces list stays accurate once it does.

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
