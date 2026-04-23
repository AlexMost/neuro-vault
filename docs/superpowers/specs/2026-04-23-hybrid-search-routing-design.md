# Hybrid Search Routing Design

**Date:** 2026-04-23

**Status:** Approved for planning

## Goal

Teach the Neuro Vault MCP server to guide agents toward the right search class first: structural tools for exact anchors, semantic tools for fuzzy recall.

## Problem

Current MCP server instructions are semantic-first. They push agents toward `search_notes` for most vault questions, even when the user is clearly asking for:

- a specific note,
- a known file path or folder,
- a daily note by date,
- tag or property filtering,
- backlinks or explicit link traversal.

This causes avoidable `search_notes` calls for requests where structural lookup is faster and more precise.

## Scope

### In Scope

- Update injected MCP server instructions to describe tool routing between structural and semantic search paths
- Update README guidance to explain the routing philosophy
- Keep `AGENTS.md` / `CLAUDE.md` snippet minimal and defer main routing logic to server instructions
- Define manual smoke-test criteria before updating the vault-level `AGENTS.md`

### Out of Scope

- Changing semantic retrieval behavior inside `search_notes`
- Adding tests that assert exact `SERVER_INSTRUCTIONS` text
- Making routing enforceable at runtime
- Replacing vault-specific guidance unrelated to routing

## Design Principles

- Keep injected instructions compact because they appear in every MCP session
- Use conditional wording because the MCP server cannot assume which non-MCP tools are available
- Mention Obsidian CLI explicitly when present, but describe other tools generically as structural file tools
- Separate tool routing from semantic retrieval policy
- Treat instructions as advisory guidance, not guaranteed behavior

## Routing Model

The server instructions should become router-first instead of semantic-first.

Core rule:

- If the query contains an exact anchor, start with the structural path
- If the query is fuzzy, conceptual, or topic-based, start with the semantic path

### Exact Anchors

These should route to structural tools first, if available:

- exact note title or expected filename
- explicit path or folder reference
- daily note lookup by exact or relative date
- explicit tag, property, or wikilink
- backlinks, outgoing links, or graph traversal

Examples:

- "open Project X"
- "show yesterday's daily note"
- "find tasks tagged #ai"
- "what links to this note?"

### Semantic Triggers

These should route to semantic tools first:

- fuzzy recall when the user does not remember the exact note name
- conceptual or topic-based lookup
- multi-language recall
- requests for similar or related notes

Examples:

- "what did I write about agent orchestration?"
- "which idea did I have about local-first AI?"
- "find related notes for this topic"

## Search Routing Guidance

Add a new `## Search routing` section to injected server instructions.

This section should say:

- If exact anchors exist in the query and structural tools are available, start with them
- Prefer Obsidian CLI when it is available for exact note, path, date, tag, property, and link lookups
- When Obsidian CLI is unavailable, use whatever structural file or navigation tools are available in the current agent environment
- Use `search_notes` for fuzzy recall, conceptual lookup, and cross-language matching
- Treat `get_similar_notes` as semantic expansion, not as backlink traversal

The instructions should avoid naming every possible host tool. They only need to distinguish:

- structural lookup and navigation
- semantic search and expansion

## Combining Structural And Semantic Paths

Routing should support explicit mode switching after the first useful hit.

### Structural -> Semantic

Use when a note is found exactly and the agent now wants broader context.

Examples:

- resolve a daily note structurally, then expand with `get_similar_notes`
- open a note by exact title, then search for semantically related notes

### Semantic -> Structural

Use when semantic search finds the right note, but the agent now needs precise navigation.

Examples:

- find a note with `search_notes`, then open the exact file by path
- find a note semantically, then inspect links or backlinks structurally

## Boundary With Retrieval Policy

This work defines which class of tool to choose first.

It does not define:

- `search_notes` query rewriting policy
- `quick` vs `deep` heuristics beyond current guidance
- threshold fallback rules
- expansion internals
- block-level retrieval behavior

Those belong to semantic retrieval policy and remain separate from routing.

The instructions should make this ordering explicit:

1. Choose the search class: structural or semantic
2. If semantic is chosen, then apply the semantic retrieval policy inside `search_notes`

## README Changes

README should gain a dedicated routing section that explains:

- structural vs semantic search classes
- the difference between tool routing and retrieval policy
- examples of when each path should be used

Recommended example set:

- exact note, path, or daily note -> structural first
- topic recall or fuzzy memory -> `search_notes`
- related notes -> semantic first, then structural navigation if needed

The README snippet for `AGENTS.md` / `CLAUDE.md` should become minimal. It should:

- tell the assistant to use vault-aware tools when vault context matters
- tell the assistant not to rely on guesses
- avoid duplicating the full routing decision tree
- state that core routing logic already comes from MCP server instructions

## Vault-Level AGENTS.md Strategy

Do not update the vault-level `AGENTS.md` immediately.

First validate the new routing behavior with manual smoke tests. Only after that:

- remove the hard "prefer neuro-vault-mcp" phrasing
- reference the MCP server instructions as the primary routing source
- keep only vault-specific overrides that remain useful locally

## Validation Plan

Validation will use manual smoke testing rather than tests for `SERVER_INSTRUCTIONS`.

Required cases before updating the vault-level `AGENTS.md`:

1. Exact note, path, or daily note lookup starts with the structural path
2. Fuzzy topic recall starts with `search_notes`
3. After a semantic hit, the agent can narrow to a concrete note and continue structurally

## Implementation Notes

Expected implementation surface:

- [src/server.ts](/Users/amostovenko/git/neuro-vault/src/server.ts): replace semantic-first guidance with compact router-first instructions
- [README.md](/Users/amostovenko/git/neuro-vault/README.md): add routing philosophy and simplify the snippet
- vault-level [AGENTS.md](/Users/amostovenko/Obsidian/AGENTS.md): update only after manual validation

No server-side behavior changes are required for this design beyond instruction and documentation updates.
