# `search_notes` clarity & docs restructure

**Date:** 2026-04-27
**Status:** approved (brainstorm)

## Problem

`search_notes` exposes six parameters (`query`, `mode`, `limit`, `threshold`, `expansion`, `expansion_limit`). Their interaction is not obvious from the tool description, and one of them — `limit` in single-query mode — is silently ignored by the implementation. In a 2026-04-27 session the user tuned `limit` expecting it to broaden a `quick` search; nothing changed because `executeRetrieval` overrides it with `modeConfig.limit`. This is a real behavior bug compounded by under-documented surface.

The README and the tool description also disagree about which parameters exist (README schema lists four, Zod schema accepts six), and there is no human-facing place to read examples of what `quick` / `deep` / multi-query output actually looks like.

## Goals

1. Make `search_notes` behavior match its documentation (fix the silent `limit` drop).
2. Shrink the tool's public surface to parameters with legitimate user-facing use.
3. Give the LLM (via `tools/list` description) a single, structured, complete reference.
4. Give humans a project-documentation directory (`docs/guide/`) that can later become a doc site, with the README reduced to a landing page.

## Non-goals

- No change to search semantics (cosine math, fallback, expansion logic stay as-is).
- No parameter renames (covered by the separate parameter-naming spec).
- No new search modes.
- No transport changes (still stdio MCP).

## Scope

Three independent changes shipped as one logical unit:

1. **Behavior fix** — `executeRetrieval` honors user-supplied `limit` in single-query mode.
2. **Schema simplification** — drop `expansion` and `expansion_limit` from the public `searchNotesSchema`. They remain configurable internally via `MODE_DEFAULTS` and the `executeRetrieval` signature (used by tests and `executeMultiRetrieval`); only the MCP-facing schema shrinks.
3. **Documentation restructure**:
   - Rewrite the tool description as structured text with sections (Modes, Parameters, Examples).
   - Create `docs/guide/` with a Map-of-Content `README.md` and five topic pages.
   - Slim the project `README.md` to a landing page (why / features / quickstart / link to guide).
   - Add an ASCII flow diagram to `docs/architecture/retrieval-policy.md`.

## Architecture

No new modules. Layering stays:

```
tools.ts (schema + description)
  └─ tool-handlers.ts (validation + path filtering)
       └─ retrieval-policy.ts (mode → behavior mapping)
            └─ search-engine.ts (math)
```

The simplification is purely surface-level: `searchNotesSchema` shrinks, but `executeRetrieval` keeps its full param surface as an internal API. Existing test coverage of expansion behavior stays valid.

## Public schema (after)

```ts
const searchNotesSchema = z.object({
  query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
  mode: z.enum(['quick', 'deep']).optional(),     // default: quick
  limit: z.number().int().positive().optional(),  // default: mode's limit (3 / 8)
  threshold: z.number().min(0).max(1).optional(), // default: mode's threshold (0.5 / 0.35)
});
```

Removed: `expansion`, `expansion_limit`. Zod's default `z.object` strips unknown keys silently, so a client still passing them does not error — the values are dropped before reaching the handler, and the mode default applies. `quick` is hardcoded to `expansion=off`; `deep` is hardcoded to `expansion=on, expansionLimit=3`.

This is a **breaking change** in the strictest reading (callers passing `expansion: false` to a deep search will see different behavior). Acceptable for a pre-1.0 minor bump; the changelog must call it out.

## Behavior change — `limit` in single-query

In `src/modules/semantic/retrieval-policy.ts`:

```diff
-  const limit = modeConfig.limit;
+  const limit = input.limit ?? modeConfig.limit;
```

That single line propagates the user override into both the initial `findNeighbors` call and the post-expansion `slice(0, limit)`. Block search retains its mode-specific cap (`QUICK_BLOCK_LIMIT=5` for quick / `mode.limit` for deep) — `limit` only affects the `results` array, not `blockResults`. This asymmetry is documented in the new tool description and guide.

`tool-handlers.ts` already plumbs `input.limit` through; no change needed there for the single-query path. The multi-query path already uses `input.limit` to compute the merge cap.

## Tool description (new)

```
Search notes by semantic similarity. Best for fuzzy recall, topic exploration,
or cross-language matches. Pass short keyword queries (1-4 words), not sentences.

MODES (pick based on intent):
- "quick" (default) — specific lookup. Returns up to 3 top notes plus their
  most relevant paragraphs. Use when you want one or two specific notes.
- "deep" — topic exploration. Returns up to 8 notes plus block-level matches
  across the whole vault, with semantic expansion to related notes.
  Use for "tell me about X" or building an overview.

PARAMETERS:
- query (required): string, or array of 1-8 strings. Pass an array for
  synonyms / reformulations / translations — embedded in batch and merged
  into one ranked list with `matched_queries` per result.
- mode: "quick" | "deep" (default "quick").
- limit: max notes in `results`. Default 3 (quick) / 8 (deep). Override
  to widen or narrow the result set. Does not affect `blockResults`.
- threshold: min similarity, 0-1. Default 0.5 (quick) / 0.35 (deep).
  Raise to 0.6+ to cut weak matches; lower (e.g. 0.3) when nothing comes back.

EXAMPLES:
- "where did I write about X?" → search_notes({query: "X"}) — quick.
- "what do I know about Y?" → search_notes({query: "Y", mode: "deep"}).
- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).
```

Wording may shift during implementation; the structure (Modes / Parameters / Examples sections) is the contract.

## Documentation layout

### README (slim landing)

Sections to keep:
- Title, badges, tagline.
- ✨ Why Neuro Vault (features bullet list).
- 🏗 How it works (mermaid diagram + one-paragraph blurb).
- ⚡ Quickstart — `npm install -g`, one MCP client config example (Claude Code), one "try it" prompt.
- 📚 Documentation — short paragraph linking to `docs/guide/README.md`.
- 📄 License.

Sections to remove (move to guide):
- Per-tool API reference (all `search_notes`, `get_similar_notes`, `find_duplicates`, `get_stats`, `read_note`, `create_note`, `edit_note`, `read_daily`, `append_daily`, `set_property`, `read_property`, `remove_property`, `list_properties`, `list_tags`, `get_tag` blocks).
- Mode behavior table.
- Tips for better results.
- Search routing guidance.
- Configuration (CLI arguments, startup, AGENTS.md snippet).
- Troubleshooting.
- Limitations.
- Development.

### `docs/guide/`

A new directory under `docs/`. Structured for eventual conversion to a static doc site (mkdocs, docusaurus, or similar — out of scope here).

- **`docs/guide/README.md`** — Map of Content. One section per page with title, one-line summary, link. Treats this directory as the project's user documentation entry point.

- **`docs/guide/installation.md`** — Requirements, `npm install -g`, MCP client configs (Claude Code, Cursor, Windsurf, npx), first-run behavior (model download, embedding cache).

- **`docs/guide/semantic-search.md`** — The deep dive that resolves the original task. Sections:
  - Overview (what semantic search does, when to use it).
  - `search_notes` — modes table, parameters, multi-query, output examples for `quick` / `deep` / multi-query (real JSON).
  - Tuning guide — when to raise threshold, when expansion adds noise (link to `docs/architecture/retrieval-policy.md`).
  - `get_similar_notes` — params, example output.
  - `find_duplicates` — params, example output.
  - `get_stats` — return shape.
  - Cross-link to architecture for the flow diagram.

- **`docs/guide/vault-operations.md`** — `read_note`, `create_note`, `edit_note`, `read_daily`, `append_daily`, `set_property`, `read_property`, `remove_property`, `list_properties`, `list_tags`, `get_tag`. Each tool: signature, return shape, edge cases (overwrite, idempotent removal, list-comma limitation).

- **`docs/guide/routing.md`** — Current "Search routing guidance" content: when to use structural vs semantic, behavior-not-enforcement framing, retrieval-then-anchor pattern.

- **`docs/guide/configuration.md`** — CLI args table, startup behavior, AGENTS.md snippet, troubleshooting, limitations, development commands. Effectively the rest of the current README's `<details>` blocks.

### `docs/architecture/retrieval-policy.md`

Add ASCII flow diagram near the top, after the "What it is" section:

```
query
  │
  ▼
[embed] ──► query_vector
  │
  ▼
[findNeighbors threshold] ─► note results (top-K)
  │   (if empty AND threshold>0.3: retry at 0.3)
  ▼
[block search] ──► block results
  │   quick: scoped to matched notes, threshold=0, cap=5
  │   deep:  whole corpus, threshold=mode, limit=mode
  ▼
[expansion] (deep only) ──► merge top-3 neighbors of top results
  │
  ▼
slice(0, limit) ──► final
```

Update the "Modes" subsection to reflect that `expansion` and `expansionLimit` are no longer user-tunable (only via `mode`).

## Testing

- **Unit (existing)**: `executeRetrieval` tests for expansion stay valid — the function signature is unchanged.
- **Unit (new)**: `executeRetrieval` honors user-supplied `limit` — passing `limit: 5` in `quick` returns up to 5 results (currently only 3). This is a regression test for the bug.
- **Schema test**: `searchNotesSchema.parse({ query: "x", expansion: true })` parses successfully but `expansion` is dropped (Zod default behavior). Document via comment that this is intentional.
- **Tool list snapshot test (if it exists)** — update to match the new description; otherwise no automated snapshot, manual proof-read.
- **Multi-query**: existing tests stand; the `limit` plumbing is unchanged on that path.
- **Manual**: real MCP session — verify `search_notes({query: "X", limit: 7, mode: "quick"})` now returns up to 7 results.

## Error handling

No new error paths. The Zod schema rejects malformed input as before; downstream `ToolHandlerError` mappings are unchanged.

## Definition of Done

- `searchNotesSchema` no longer lists `expansion` / `expansion_limit`.
- `executeRetrieval` uses `input.limit ?? modeConfig.limit`.
- Tool description matches the structure in this spec (Modes / Parameters / Examples).
- `docs/guide/README.md` exists with a Map of Content linking to all pages.
- `docs/guide/installation.md`, `semantic-search.md`, `vault-operations.md`, `routing.md`, `configuration.md` exist with the content described above.
- Project `README.md` is reduced to landing-page sections only (per the list in this spec).
- `docs/architecture/retrieval-policy.md` contains the ASCII flow diagram and reflects that expansion is mode-controlled only.
- New regression test for user-supplied `limit` in single-query mode.
- `npm test`, `npm run lint`, `npx tsc --noEmit` — all green.
- Conventional Commits messages (`feat!:` for the schema change since it's a breaking surface, `docs:` for the doc restructure).
- New minor version released per AGENTS.md release flow on `main`.

## Open questions

None at brainstorm time. Surface during implementation if any.
