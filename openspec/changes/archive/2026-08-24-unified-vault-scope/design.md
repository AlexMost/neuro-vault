## Context

Slice #1 of the own-embedding-pipeline queue (wayfinder map
`.scratch/own-embedding-pipeline/map.md`; decisions grilled with the user in
ticket 04, slicing in ticket 09, both resolved 2026-08-23 — see
`brainstorm.md` for the transcription).

Current state, verified against `main`:

- `FsVaultReader.scan` (`src/lib/obsidian/vault-reader.ts:82-113`) is the
  discovery chokepoint: one fast-glob call — `**/*.md`, `dot: false`,
  `onlyFiles: true`, no `ignore` — behind an injectable `FsGlob` seam.
  `dot: false` is the *only* exclusion in the lexical world today.
- Every discovery surface routes through `scan`: the lexical index
  (`lexical-index.ts:51`), `query_notes` (`query-notes.ts:76`),
  `listMatchingPaths` (`list-matching-paths.ts:58,64`), `get_vault_overview`
  (`vault-overview.ts:70`), the wikilink graph (`wikilink-graph.ts:86`),
  `list_tags`/`list_properties` (`fs-vault-provider.ts:293,311`), and
  note-name resolution (`resolve-note-name.ts:14`).
- Semantic membership is inherited: `smart-connections-loader.ts` takes every
  `smart_sources:` entry in the AJSON; SC's own exclusion config is applied by
  the plugin before writing and is never read by the server.
- `.neuro-vault/` exists as a convention with exactly one file
  (`vault-conventions.ts`, best-effort reader, failures → `null`). There is no
  per-vault config reader.
- `fast-glob ^3.3.3` is the only direct glob dependency. `picomatch` is
  transitive-only (prod copy nested under `micromatch`); importing it today
  would be a phantom dependency.

Constraint: the multi-vault registry (`vault-registry.ts`) builds entries
async in `VaultRegistry.create` — per-vault config I/O at build time is free.

## Goals / Non-Goals

**Goals:**

- One per-vault scope module that answers "is this file visible" for every
  discovery surface, consumed by `vault-reader.scan` in this slice and by the
  own-corpus indexer in slice #2.
- Exclusion layering: always-excluded dot-paths → built-in defaults
  (`Templates/`, root `.gitignore` entries) → union with
  `.neuro-vault/config.json` `"exclusions"`.
- Establish the `.neuro-vault/config.json` convention.
- `docs/architecture/vault-scope.md` as the concept's single living doc.

**Non-Goals:**

- No embedding/indexer code, no corpus writes (slice #2), no watcher (slice
  #5), no ADR yet — the ADR revising ADR-0006 belongs to slice #2 per the map.
- No `excluded_headings` (unused in the live SC config; would be an
  `embed_version` concern anyway).
- No negation/re-include mechanism in config (YAGNI, union only).
- No nested `.gitignore`, no negation lines, no gitignore ordering semantics.
- No CLI surface change, no MCP parameter change.
- Not an ACL: `read_notes` by explicit path bypasses scope by design.

## Decisions

### D1: One scope module for both legs

- **Choice**: a single per-vault scope object, built once per vault entry,
  consulted by the lexical scan now and the semantic indexer in slice #2.
  Embedding-specific rules (`min_chars`, embed-text truncation) stay
  index-side: scope says *which files*, the index says *what part of a file*.
- **Rationale**: divergent membership is the observed failure mode (weird
  `found_in` combinations); a third independent answer for the indexer would
  entrench it.
- **Alternative considered**: per-leg exclusion configs — rejected, that is
  the status quo failure mode.

### D2: Exclusion layering and semantics

- **Choice**: three layers, all merged by union:
  1. **Always excluded, non-configurable**: any path with a dot-segment
     (`.obsidian`, `.smart-env`, `.git`, `.neuro-vault`, `.trash`, …) —
     codifies the current `dot: false` behaviour and auto-covers the future
     `.neuro-vault/eval/` golden set.
  2. **Built-in defaults**: `Templates/` + the entries of the vault's root
     `.gitignore`.
  3. **User config**: `.neuro-vault/config.json` → `"exclusions": [...]`.
- **Rationale**: grilled decisions Q2–Q5 (brainstorm). Union-only keeps the
  mental model to "more entries = fewer files", no ordering or override rules.
- **Alternative considered**: negation/override mechanism — rejected (YAGNI;
  nobody has asked to re-include `Templates/`).

### D3: Pattern engine — fast-glob `ignore` for scan, picomatch predicate for membership

- **Choice**: the scope module compiles one pattern list and exposes two
  views: `ignorePatterns` (fed into the existing fast-glob call's `ignore`
  option) and an `isExcluded(relPath)` predicate compiled with **picomatch,
  added as a direct dependency**. Standard globs, anchored at the vault root.
- **Rationale**: the scan needs glob-time ignoring (cheap, no post-filter);
  slice #2's indexer and reconcile need a predicate for paths that did not
  come from a glob. fast-glob's `ignore` is picomatch-backed internally, so
  the two views agree by construction. The brainstorm said "picomatch —
  already a dependency"; code inspection shows it is transitive-only, so it
  must be added explicitly rather than imported as a phantom dep.
- **Alternatives considered**: (a) `ignore` option only, defer the predicate
  to slice #2 — rejected: the predicate *is* the capability ("is this file
  visible"), and deferring it would make slice #2 re-open this module's
  contract; (b) reuse `path-prefix-set.ts` prefix matching — rejected: config
  entries are globs, not prefixes.
- **SC quirks deliberately not reproduced**: no `file**`-style implicit
  prefixing. Known membership diff vs the live SC corpus: `Untitled.md` in
  the vault root (SC's `file_exclusions: "Untitled"`); to be noted during the
  parity diff in later slices, not handled here.

### D4: Root `.gitignore` interpretation — minimal, deterministic subset

- **Choice**: read the vault root's `.gitignore` only. Skip blank lines,
  comments (`#`), and negation lines (`!...`). Each remaining entry, after
  stripping a trailing slash, excludes the path itself and everything under
  it (`<entry>` and `<entry>/**`), anchored at the vault root.
- **Rationale**: enough for the observed vault at a fraction of gitignore's
  behaviour surface. Root-anchoring diverges from git's "match at any level"
  rule for slash-less entries — accepted: predictability over fidelity, and
  the module's own docs state the subset.
- **Alternative considered**: full gitignore semantics (nested files,
  negation, ordering, unanchored matching) — rejected: large imported
  behaviour surface, zero present users of the extra fidelity.
- Accepted behaviour change: the live vault's root `.gitignore` names
  `docs/superpowers/` — it disappears from lexical discovery. SC already
  excludes it semantically; the legs align.

### D5: Config file contract and failure handling

- **Choice**: `.neuro-vault/config.json`, key `"exclusions": string[]`.
  Read once per vault at registry build (`VaultRegistry.create` is already
  async). Missing file → defaults. Unreadable file, invalid JSON, or invalid
  shape → **stderr warning + defaults**; the server keeps serving.
- **Rationale**: follows the `vault-conventions.ts` best-effort precedent but
  adds the warning — scope config changes search membership, so a typo
  silently collapsing to `null` (the conventions behaviour) would be
  invisible. Failing fast was rejected: one bad vault must not kill a
  multi-vault server.
- **Alternative considered**: env var / CLI flag for exclusions — rejected:
  per-vault state belongs in the vault (Q5; CLI surface unchanged).

### D6: Scope lives on the vault entry; scan consumes it

- **Choice**: `IVaultEntry` gains the scope; `IVaultEntryDeps` gains a
  `scopeFactory`, wired in `server.ts`'s `buildDefaultVaultEntryDeps`.
  `FsVaultReader.scan` filters its results through the scope's predicate —
  the predicate is authoritative — and additionally passes `ignorePatterns`
  to fast-glob on unprefixed scans as a traversal prune. (Prefixed scans run
  with `cwd` moved to the prefix, where root-anchored patterns would not
  match; the post-filter on the re-prefixed paths handles that case with no
  pattern rewriting.) All eight scan consumers inherit membership with zero
  code changes of their own.
- **Rationale**: `scan` is the existing chokepoint; per-entry placement
  mirrors every other per-vault facility (`readConventions`,
  `filterExisting`) and matches the multi-vault decision from 2026-08-24
  (scope, like backend/watcher later, is per vault-entry).
- **Consequence, stated deliberately**: backlink counts (wikilink graph),
  basename→path note resolution, `total_notes`/`folders`, and rank-fusion's
  adaptive `k` (N = scan length, `rank-fusion.md`) all shift when scope
  shrinks. That is the point — one definition — but each is named in the doc
  sweep. Links *to* an excluded note become unresolved targets, same as links
  to any non-existent note; excluded notes contribute no edges because they
  are never scanned.

### D7: Scope is discovery, not ACL

- **Choice**: scope governs scan/search/query/indexing. `read_notes` with an
  explicit path reads excluded files (templates, golden set — legitimate
  direct reads). Config changes are membership changes: no `embed_version`
  bump, no special invalidation — the next scan (and, in later slices, the
  next reconcile) reflects the current config.
- **Rationale**: grilled decisions Q7/Q9; ACL is a different capability with
  different threat modelling, and pretending otherwise would over-promise.

## Risks / Trade-offs

- **[Risk] Silent membership shifts in secondary surfaces** — backlink
  counts, name resolution, `total_notes` change without an obvious cause for
  a user who never reads release notes. → Mitigation: CHANGELOG entry states
  the behaviour change explicitly; `docs/architecture/vault-scope.md` lists
  every governed surface; doc sweep covers all statements of the old rule.
- **[Risk] Config typo silently ignored** → Mitigation: stderr warning on
  unreadable/invalid config (D5) — visible in MCP client logs.
- **[Risk] Exact-options tests break** — `vault-reader.test.ts:158-163,
  204-209` assert the literal glob options object. → Mitigation: expected,
  updated in the same slice; test now asserts scope patterns are passed.
- **[Trade-off] Root-anchored gitignore subset** diverges from git semantics
  for slash-less entries → accepted for predictability; documented in the
  concept file.
- **[Trade-off] Union-only config** cannot re-include a default-excluded
  path → accepted (YAGNI); revisit only on real demand.
- **[Trade-off] `Untitled.md` membership diff vs SC corpus** → accepted;
  noted for the parity diff in later slices rather than reproducing SC's
  quirk semantics.

## Migration Plan

N/A — no deployment change, no data migration, no config migration (absent
config file = defaults). Single PR; rollback = revert. The behaviour change
(gitignored vault paths leaving discovery) ships in a minor release with an
explicit CHANGELOG note.

## Open Questions

None blocking. One flagged item for the user, not for this slice: the map
assigns the ADR that revises ADR-0006 to slice #2 (`own-corpus-indexer`), so
this change ships with a `docs/architecture/vault-scope.md` concept file and
no new ADR — say the word if you want an ADR for the scope/config convention
itself instead.
