# mcp-tool-surface Specification

## Purpose

The set of tools the MCP server exposes, and the deliberate exclusions from it. This capability records which tool surface is _intentional_ — both the tools that exist and the ones removed because another tool covers them (or whose capability was deliberately surrendered) — so that a tool's absence reads as a decision, not an oversight, and a rarely-used tool is not mistaken for dead weight. It is enforced against the canonical `TOOL_NAMES` list and the server's registered tool set.
## Requirements
### Requirement: Reading a single frontmatter value uses read_notes

The server SHALL NOT expose a `read_property` tool. Reading one frontmatter value SHALL be served
by `read_notes` with `fields: ['frontmatter']` (or by `query_notes`), which returns the same value
inside the note's frontmatter object with no data loss. `read_property` SHALL NOT appear in the
canonical tool-name list, the operations module's registered tools, or any live documentation or
parameter-dictionary row.

#### Scenario: read_property is not registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `read_property` is absent from the operations module and from `TOOL_NAMES`

#### Scenario: the same value is obtained from read_notes

- **WHEN** a caller needs one frontmatter key of a note and calls `read_notes({ paths: [<path>], fields: ['frontmatter'] })`
- **THEN** the returned item's `frontmatter` contains that key with the same value `read_property` would have returned

### Requirement: Frontmatter property enumeration is served by get_vault_overview

The server SHALL NOT expose a `list_properties` tool. The vault's frontmatter property list
(`{ name, type, count }`) SHALL be served by `get_vault_overview`, which returns the properties
ranked by count and capped at the top 30. Enumeration of the rare/zero-count tail beyond that cap is
intentionally not provided via MCP. The underlying `provider.listProperties()` SHALL remain, because
`get_vault_overview` depends on it.

#### Scenario: list_properties is not registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `list_properties` is absent from the operations module and from `TOOL_NAMES`

#### Scenario: get_vault_overview still returns the property list

- **WHEN** `get_vault_overview` is called
- **THEN** it returns a `properties` array of `{ name, type, count }` (top 30 by count), unchanged by this change

### Requirement: Embedding-corpus statistics are not exposed via MCP

The server SHALL NOT expose a `get_stats` tool. Embedding-corpus statistics — block count,
embedding dimension, model key, and the corpus note count — SHALL NOT be retrievable through the
MCP surface. This is a deliberate surface reduction, not a delegation: no other tool reports these
fields. Code that existed solely to support `get_stats` (`ToolStats`, `readEmbeddingDimension`) SHALL
be removed; `modelKey`, still consumed by `find_duplicates`, SHALL remain.

#### Scenario: get_stats is not registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `get_stats` is absent from the semantic module and from `TOOL_NAMES`

#### Scenario: no MCP tool reports embedding-corpus internals

- **WHEN** any remaining tool's output is inspected
- **THEN** none returns the embedding block count, embedding dimension, or model key

### Requirement: Unique low-use tools remain available

The server SHALL continue to expose `get_note_links`, `find_duplicates`, and `remove_property`.
Each is the sole path to its capability — wikilink edge lists (incoming + outgoing adjacency),
a vault-wide all-pairs near-duplicate sweep, and frontmatter-key deletion respectively — and so is
retained despite low usage. Their retention SHALL be made legible by a "when to reach for it" note in
`AGENTS.md`.

#### Scenario: the three unique tools stay registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `get_note_links`, `find_duplicates`, and `remove_property` are all present

#### Scenario: AGENTS.md records when to use each kept tool

- **WHEN** `AGENTS.md` is read
- **THEN** it contains a short "when to reach for it" note for `get_note_links`, `find_duplicates`, and `remove_property`

### Requirement: Exact-text search is served by search_notes, not a standalone tool

The server SHALL NOT expose a standalone `search_text`, `search_by_text`, or
`search_semantic` tool. Lexical/exact-match search over titles, headings, and
bodies SHALL be served by `search_notes` — hybrid by default, lexical-only via
`mode: "lexical"`. This is a deliberate single-entry-point decision: splitting
the legs into separate tools loses the cross-leg intersection signal and
leaves silent semantic noise uncured. None of these names SHALL appear in the
canonical `TOOL_NAMES` list, the registered tool set, or live documentation as
available tools.

#### Scenario: no standalone lexical search tool is registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `search_text`, `search_by_text`, and `search_semantic` are absent from both modules and from `TOOL_NAMES`

#### Scenario: lexical-only search is reachable through search_notes

- **WHEN** a caller needs exact text matches only and calls `search_notes` with `{ query: "<term>", mode: "lexical" }`
- **THEN** the response's `lexical_matches` provides the exact-match results a standalone tool would have returned, with `semantic_matches: []`

