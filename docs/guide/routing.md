# Routing Between Tools

Tool routing and retrieval policy are related, but not the same thing. Routing is about _which tool to call_; retrieval policy is about _what happens once `search_notes` is called_.

## Rules of thumb

`search_notes` is one hybrid entry point (semantic + lexical); route by what you know about the request:

- **Fuzzy or unknown wording** — you don't know the exact term the note uses → `search_notes` (`mode: "hybrid"`, the default). Both legs run; a note hit by both is the strongest signal.
- **Exact term, name, or code — or no embedding corpus available** → `search_notes({ mode: "lexical" })`. Substring matching over title/headings/body, independent of embeddings; works even on a cold or absent Smart Connections index.
- **You already know the structural key** (a frontmatter field, a tag, a folder) → `query_notes`.
- **You know exactly which note** (a path, or a name you can resolve) → `read_notes`.
- Use `get_similar_notes` after you already have a relevant note and want semantic + wikilink expansion.
- Treat the routing guidance as **behavior, not enforcement**; the server does not hard-block other tool choices.

## Examples

| User asks                                    | Tool to use                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Read the note 'Q1 OKRs'"                    | `search_notes({ query: "Q1 OKRs" })` to resolve the path, then `read_notes({ paths: ["..."] })` (single path → full body by default) |
| "What's the status of Quarterly review?"     | `search_notes({ query: "Quarterly review" })` to resolve the path, then `read_notes({ paths: ["..."], content: "frontmatter" })` and read the `status` key |
| "Show me all notes tagged #mcp"              | `query_notes({ filter: { tags: "mcp" } })`                                                                                           |
| "What did I write about building AI agents?" | `search_notes({ query: "building AI agents" })` (hybrid default)                                                                     |
| "Where's the note that mentions PARAM_DICT?" | `search_notes({ query: "PARAM_DICT", mode: "lexical" })` — exact code, no need for the semantic leg                                  |
| "Tell me everything I know about embeddings" | `search_notes({ query: "embeddings", effort: "deep" })`                                                                              |
| "Show me notes related to neuro-vault.md"    | `get_similar_notes({ path: "Projects/neuro-vault.md" })`                                                                             |
| "Read today's daily note"                    | `read_daily()`                                                                                                                       |
| "Append a TODO to today"                     | `read_daily()` → `edit_note({ path, content: body + "- [ ] new todo" })` (see [Reading & Modifying](./reading-and-modifying.md))      |

## Multi-note triage: preview first, then full

When `read_notes` is called with two or more paths (the typical `search_notes` / `query_notes` → `read_notes` triage pattern), it defaults to `content: 'preview'` — each item returns frontmatter plus a bounded body slice to keep the MCP response payload small. Items whose body was cut carry `truncated: true`. Before citing or editing a specific note, re-read it individually with `content: 'full'` to get the complete body.

```json
// triage hop — multi-path, defaults to preview
{ "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md", "Archive/old-idea.md"] }

// follow-up for the note you want to quote or edit
{ "paths": "Notes/embeddings.md", "content": "full" }
```

## Tag-driven questions are exact, not fuzzy

For "which notes are tagged X?" or "show me everything in #ai", use `query_notes` with `{ filter: { tags: '<name>' } }` rather than `search_notes`. The answer is precise (a frontmatter scan) and skipping `search_notes` saves an embedding round-trip.
