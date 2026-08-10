# MCP Parameter Dictionary

The cross-tool naming contract for the server's MCP tools. The rationale — why the names are unified and why a rename costs a major version — is [ADR-0005](../adr/0005-mcp-parameter-dictionary.md); this file is the reference table that contract enforces.

## The dictionary

One concept = one parameter name across every tool the server exposes. New tools must follow this dictionary for any concept listed here; renames cost a major version.

| Concept                                              | Param                 | Used by                                                                            |
| ----------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| Vault-relative POSIX path                            | `path`                | `create_note`, `edit_note`, `set_property`, `remove_property`, `get_similar_notes` |
| Vault-relative POSIX path list                       | `paths`               | `read_notes`                                                                       |
| Vault-relative POSIX path subtree (or list)          | `path_prefix`         | `query_notes`, `search_notes` (inside `filter`)                                    |
| Subtrees to exclude (string or list)                 | `exclude_path_prefix` | `query_notes`, `search_notes` (inside `filter`)                                    |
| Wikilink-style note identifier                       | `name`                | `create_note`, `edit_note`, `set_property`, `remove_property`                      |
| Frontmatter property key                             | `key`                 | `set_property`, `remove_property`                                                  |
| Semantic search query                                | `query`               | `search_notes`                                                                     |
| Structured query filter (MongoDB)                    | `filter`              | `query_notes`                                                                      |
| Which search legs run: `hybrid` \| `lexical`         | `mode`                | `search_notes`                                                                     |
| Result volume / exploration depth: `quick` \| `deep` | `effort`              | `search_notes`                                                                     |
| Similarity floor, hard filter, tool-scoped default   | `threshold`           | `search_notes` (semantic leg's note scores only — never blocks, expansion, or the lexical leg), `get_similar_notes` (semantic branch only), `find_duplicates` |
| Expansion-leg similarity floor, seed↔note scale      | `expansion_floor`     | `search_notes`                                                                     |

## Rules

`name` vs `path` (note identifier): tools that take both for the same concept require **exactly one** — both or neither produces `INVALID_ARGUMENT`. `read_notes` is paths-only (batch reads from disk); to read by wikilink, resolve to a path first via `search_notes` or another path-producing tool.

`.md` auto-append: when the target is an _individual note_, `.md` is appended if the final path segment has no extension (`Tasks/Foo` → `Tasks/Foo.md`). This applies to `create_note`, `edit_note`, `set_property`, `remove_property`, `get_note_links`, and `get_similar_notes`. Subtree-prefix uses (`path_prefix`, `exclude_path_prefix`) and `read_notes` paths do not auto-append.

`threshold` on `search_notes` reaches the semantic leg's note scores only — never the block-evidence pass (always filtered at the internal mode default, 0.35), never the expansion leg (owned by `expansion_floor` below), never the lexical leg (no similarity score to threshold). An explicit value is a hard filter: notes scoring below it are excluded with no rescue, and zero hits is an honest answer. Omitting `threshold` applies the effort default (0.5 quick / 0.35 deep) and, only in that default case, retries once at 0.3 if nothing passes — surfaced per query as `semantic_fallback: true` in `query_stats` (array `query` only; see [`docs/guide/finding-notes.md`](../guide/finding-notes.md)). `expansion_floor` (`search_notes` only) is a separate knob for the expansion leg's seed↔note similarity scale — empirically 0.89–0.985, 0.9+ typical, incomparable to the semantic leg's query↔note scale — defaulting to 0.35; `threshold` never reaches it. `expansion_floor` shares its note↔note similarity scale with `get_similar_notes`' `threshold` (not `search_notes`' `threshold`, which is query↔note-scaled).

## Tool-local parameters not in the dictionary

Some parameters are intentionally _not_ in the shared dictionary because they are meaningful only on one tool and should not be generalised. The dictionary table above covers only cross-tool shared concepts.

**`content` on `read_notes`** is a body-granularity selector (`'full'` / `'preview'` / `'frontmatter'`) that is specific to `read_notes` and has no cross-tool meaning. It replaced the old `fields: ('frontmatter' | 'content')[]` parameter; that removal is a breaking change and was shipped as part of a major version increment. `content` does not appear in the dictionary table and must not be reused as a shared concept name for a different purpose on other tools.

## Change log

- **This major**: `mode` on `search_notes` is redefined. It previously meant `quick | deep` (result volume / exploration depth). It now means `hybrid | lexical` (which search legs run — hybrid runs both a semantic and a lexical leg; lexical runs exact text matching only). The old meaning moved to a new `effort` param (`quick | deep`). This is a breaking rename per [ADR-0005](../adr/0005-mcp-parameter-dictionary.md): existing callers passing `mode: "quick"` or `mode: "deep"` must switch to `effort`.

## Why it exists

Tool parameter names are a public contract an LLM (and client configs) encode. Unifying them gives a predictable surface — once the model learns `path`, it transfers across every tool — and makes adding a tool a lookup rather than a naming decision. The cost of stability is that renaming a shared name is a breaking change; see [ADR-0005](../adr/0005-mcp-parameter-dictionary.md). Changes that touch a tool's parameters are routed through `rules.design` in `openspec/config.yaml`, which requires conforming to this table.
