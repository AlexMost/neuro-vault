# MCP Parameter Dictionary

The cross-tool naming contract for the server's MCP tools. The rationale — why the names are unified and why a rename costs a major version — is [ADR-0005](../adr/0005-mcp-parameter-dictionary.md); this file is the reference table that contract enforces.

## The dictionary

One concept = one parameter name across every tool the server exposes. New tools must follow this dictionary for any concept listed here; renames cost a major version.

| Concept                                     | Param                 | Used by                                                                                             |
| ------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| Vault-relative POSIX path                   | `path`                | `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_similar_notes` |
| Vault-relative POSIX path list              | `paths`               | `read_notes`                                                                                        |
| Vault-relative POSIX path subtree (or list) | `path_prefix`         | `query_notes`, `search_notes` (inside `filter`)                                                     |
| Subtrees to exclude (string or list)        | `exclude_path_prefix` | `query_notes`, `search_notes` (inside `filter`)                                                     |
| Wikilink-style note identifier              | `name`                | `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`                      |
| Frontmatter property key                    | `key`                 | `set_property`, `read_property`, `remove_property`                                                  |
| Semantic search query                       | `query`               | `search_notes`                                                                                      |
| Structured query filter (MongoDB)           | `filter`              | `query_notes`                                                                                       |

## Rules

`name` vs `path` (note identifier): tools that take both for the same concept require **exactly one** — both or neither produces `INVALID_ARGUMENT`. `read_notes` is paths-only (batch reads from disk); to read by wikilink, resolve to a path first via `search_notes` or another path-producing tool.

`.md` auto-append: when the target is an _individual note_, `.md` is appended if the final path segment has no extension (`Tasks/Foo` → `Tasks/Foo.md`). This applies to `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_note_links`, and `get_similar_notes`. Subtree-prefix uses (`path_prefix`, `exclude_path_prefix`) and `read_notes` paths do not auto-append.

## Tool-local parameters not in the dictionary

Some parameters are intentionally _not_ in the shared dictionary because they are meaningful only on one tool and should not be generalised. The dictionary table above covers only cross-tool shared concepts.

**`content` on `read_notes`** is a body-granularity selector (`'full'` / `'preview'` / `'frontmatter'`) that is specific to `read_notes` and has no cross-tool meaning. It replaced the old `fields: ('frontmatter' | 'content')[]` parameter; that removal is a breaking change and was shipped as part of a major version increment. `content` does not appear in the dictionary table and must not be reused as a shared concept name for a different purpose on other tools.

## Why it exists

Tool parameter names are a public contract an LLM (and client configs) encode. Unifying them gives a predictable surface — once the model learns `path`, it transfers across every tool — and makes adding a tool a lookup rather than a naming decision. The cost of stability is that renaming a shared name is a breaking change; see [ADR-0005](../adr/0005-mcp-parameter-dictionary.md). Changes that touch a tool's parameters are routed through `rules.design` in `openspec/config.yaml`, which requires conforming to this table.
