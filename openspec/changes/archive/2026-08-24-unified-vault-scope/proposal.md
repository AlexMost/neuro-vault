Tracked by: #81

## Why

"Which vault files are visible" has two independent answers today. The lexical leg scans with `dot: false` + `**/*.md` and no other exclusion mechanism (`vault-reader.ts:103`); the semantic leg inherits whatever Smart Connections chose to embed — SC's exclusion config is applied by the plugin before the AJSON is written and the server never reads it. The own-corpus indexer (next slice of the own-embedding-pipeline queue) would need a third answer unless a shared one exists first — and divergent membership already surfaces as unprincipled `found_in` combinations in `search_notes`. This slice builds the single scope module both legs consult and establishes the `.neuro-vault/` per-vault config convention that later slices (corpus storage, eval golden set) build on. It contains no embedding code, so it ships first and alone.

## What Changes

**Vault file membership (one scope, both legs)**

- From: lexical membership = fast-glob defaults; semantic membership = inherited from Smart Connections; no exclusion mechanism of our own anywhere.
- To: one per-vault scope module answers membership for every scan-derived surface. Layers: dot-paths always excluded (non-configurable) → built-in defaults `Templates/` + the vault's root `.gitignore` entries (root-only, negation lines ignored) → union with user globs from `.neuro-vault/config.json` `"exclusions"`.
- Reason: one definition prevents leg divergence and gives slice #2 (`own-corpus-indexer`) its membership answer for free.
- Impact: behaviour change — paths named by the vault's root `.gitignore` (in the live vault: `docs/superpowers/`) disappear from lexical search, `query_notes`, tag/property listings, vault overview, backlink counts, and name resolution. SC already excluded them semantically, so the legs align rather than diverge. `read_notes` by explicit path still reads excluded files (scope is discovery, not ACL).

**`vault-reader.scan` consumes the scope**

- From: hardcoded glob options, no `ignore`.
- To: scan passes the scope's exclusion patterns to fast-glob; every scan consumer (lexical index, `query_notes`, `list_matching_paths`, `list_tags`, `list_properties`, `get_vault_overview`, wikilink graph, note-name resolution) inherits scope for free.
- Reason: `scan` is the single chokepoint the repo already routes discovery through.
- Impact: non-breaking API-wise; membership shifts as above.

**Per-vault config file (new convention)**

- From: `.neuro-vault/` holds only `for-external-agents.md`.
- To: `.neuro-vault/config.json` is read per vault at registry build; key `"exclusions": [...]` (standard globs anchored at the vault root, union with defaults). No CLI change, no MCP parameter change.
- Reason: per-vault config belongs in the vault; the convention is load-bearing for later slices.
- Impact: non-breaking; absent file = defaults.

## Capabilities

### New Capabilities

- `vault-scope`: the single definition of vault file visibility — exclusion layering (dot-paths, built-in defaults, root `.gitignore`, config union), pattern semantics, the discovery-not-ACL boundary, and which surfaces it governs.

### Modified Capabilities

- `headless-vault-operations`: tag and property listings aggregate from the **scoped** vault scan (spec currently says "from the vault scan" with no scope notion).

## Impact

- **Code**: new scope module in `src/lib/obsidian/`; `vault-reader.ts` scan options; `vault-registry.ts` (`IVaultEntry` + deps factory) and `server.ts` wiring; a config reader following the `vault-conventions.ts` best-effort pattern.
- **Dependencies**: `picomatch` becomes a direct dependency (the brainstorm assumed it already was — it is only transitive; fast-glob stays for the scan itself).
- **Tests**: `vault-reader.test.ts` asserts the exact glob options object (two sites) — updated; new scope-module tests; registry wiring coverage.
- **Docs**: `docs/architecture/vault-scope.md` (new concept file) + sweep of scan-behaviour statements (`vault-reader.md`, `lexical-search.md`, `query.md`, `rank-fusion.md`, `wikilink-graph.md`, `vault-provider.md`, `vault-registry.md`, `vault-conventions.md`, `obsidian-lib.md`, `docs/guide/configuration.md`, `docs/guide/finding-notes.md`).
- **Not touched**: CLI surface, MCP tool parameters, semantic corpus loading (still SC — its membership is superseded in later slices), `embed_version` semantics.
