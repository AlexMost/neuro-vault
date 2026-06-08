## Why

The W23 + W24 usage reports flagged six little-used tools — four called in **zero** buckets two
weeks running (`find_duplicates`, `get_note_links`, `list_properties`, `remove_property`) and two
used rarely (`get_stats`, `read_property`). Every extra tool widens the surface ToolSearch scans
for schemas and adds noise to `unusedTools`. But "not called" ≠ "duplicate", so this is an audit,
not a purge: verify each candidate's overlap on a real example, then remove only what is genuinely
covered (or deliberately surrendered) and keep what is unique. Doing it now trims the contract
before the surface grows further.

## What Changes

The audit (source read + live overlap check per candidate) found **3 of 6 removable, 3 unique**.

**Remove `read_property`** (operations)

- From: a tool returning `{ vault, value }` for one frontmatter key, by `name` or `path`.
- To: removed. "Status of X" is served by `read_notes(fields: ['frontmatter'])` / `query_notes`.
- Reason: verified — `read_notes` returns the same value (inside full frontmatter) with no data loss; the only sliver lost is ergonomic (value-only return + `name` lookup).
- Impact: **Breaking** (tool removed). `docs/guide/routing.md` currently recommends it → re-routed.

**Remove `list_properties`** (operations)

- From: a tool listing **all** `{ name, type, count }` frontmatter keys.
- To: removed. `get_vault_overview` returns the same `properties` list (capped at top-30).
- Reason: verified — overview covers every key with `count ≥ 1` that matters; the dropped tail is rare/`count: 0` noise. User chose remove-outright over lifting the cap. `provider.listProperties()` stays (overview calls it); `get_vault_overview` is unchanged.
- Impact: **Breaking** (tool removed); full-tail enumeration via MCP is given up.

**Remove `get_stats`** (semantic)

- From: a tool reporting embedding-corpus stats (`totalNotes`, `totalBlocks`, `embeddingDimension`, `modelKey`).
- To: removed.
- Reason: **deliberate surface cut, not deduplication** — nothing else reports these fields, and they cannot fold into the operations-module `get_vault_overview` without coupling. The user accepted losing in-MCP corpus diagnostics (diagnosable outside the server).
- Impact: **Breaking** (tool removed); corpus block/dimension/model and the corpus-vs-disk drift signal are no longer observable via MCP.

**Keep `get_note_links`, `find_duplicates`, `remove_property`** — unused but unique (sole source of wikilink edge lists / vault-wide all-pairs dedup / frontmatter-key deletion). Each gets a one-line "when to reach for it" nudge in `AGENTS.md` so it is not re-flagged as dead.

Net: operations 12 → 10 tools, semantic 4 → 3 tools.

## Capabilities

### New Capabilities

- `mcp-tool-surface`: pins which tools the server exposes after the audit — asserts the three
  removed tools are gone, records the covering tool / accepted loss for each, and asserts the three
  unique tools remain available.

### Modified Capabilities

<!-- None. The `baseline` capability (cross-cutting invariants) is unaffected; per-tool behaviour was never specced, so this introduces the surface as a new capability rather than modifying one. -->

## Impact

- **Code (remove):** `src/modules/operations/tools/read-property.ts`,
  `src/modules/operations/tools/list-properties.ts`, `src/modules/semantic/tools/get-stats.ts`;
  their entries in `src/lib/tool-names.ts`, `src/modules/operations/tools/index.ts`,
  `src/modules/semantic/tools/index.ts`, and the registrations in `src/server.ts`. Prune now-dead
  helpers/types (`ToolStats`, `readEmbeddingDimension`) and `provider.readProperty` **iff** no other
  caller remains. **Keep** `provider.listProperties()` (used by `get_vault_overview`) and `modelKey`
  (used by `find_duplicates`).
- **Tests (delete, not skip):** `test/operations/tools/read-property.test.ts`,
  `test/operations/tools/list-properties.test.ts`, `test/semantic/tools/get-stats.test.ts`, and the
  three tools' references in `test/server-modules.test.ts`, `test/server-instructions.test.ts`,
  `test/operations/tools.test.ts`, `test/operations/tools/_helpers.ts`, the provider tests, and
  `test/lib/obsidian/vault-overview.test.ts`. Suite count drops intentionally.
- **Docs (live only; `docs/superpowers/` is frozen):** `docs/guide/routing.md`,
  `docs/guide/vault-operations.md`, `docs/guide/semantic-search.md`, `docs/guide/README.md`,
  `docs/guide/configuration.md`, `docs/guide/installation.md`,
  `docs/architecture/module-structure.md` (tool counts + groups),
  `docs/architecture/mcp-parameter-dictionary.md` (`read_property` rows),
  `docs/architecture/note-path-resolution.md`, `docs/architecture/query.md`, `README.md`,
  and a "when to reach for it" nudge for the three kept tools in `AGENTS.md`.
- **Contract / release:** breaking (tools removed) → major version **10.1.0 → 11.0.0**.
