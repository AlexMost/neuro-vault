# mcp-tool-surface — delta spec

## ADDED Requirements

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
