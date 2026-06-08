# Routing Between Tools

Tool routing and retrieval policy are related, but not the same thing. Routing is about _which tool to call_; retrieval policy is about _what happens once `search_notes` is called_.

## Rules of thumb

- Use **structural tools** first — your assistant's own file/path/title tools, or vault operations like `read_notes`, `read_property`, `query_notes` — for exact file, title, path, daily note, tag, property, wikilink, backlink, and link-traversal requests.
- Use `search_notes` for fuzzy topic, concept, and semantic retrieval.
- Use `get_similar_notes` after you already have a relevant note and want semantic expansion.
- Treat the routing guidance as **behavior, not enforcement**; the server does not hard-block other tool choices.
- Use semantic retrieval to find likely notes, then switch to structural tools when you need exact anchors.

## Examples

| User asks                                    | Tool to use                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Read the note 'Q1 OKRs'"                    | `search_notes({ query: "Q1 OKRs" })` to resolve the path, then `read_notes({ paths: ["..."] })` (single path → full body by default) |
| "What's the status of Quarterly review?"     | `read_property({ name: "Quarterly review", key: "status" })`                                                                         |
| "Show me all notes tagged #mcp"              | `query_notes({ filter: { tags: "mcp" } })`                                                                                           |
| "What did I write about building AI agents?" | `search_notes({ query: "building AI agents" })`                                                                                      |
| "Tell me everything I know about embeddings" | `search_notes({ query: "embeddings", mode: "deep" })`                                                                                |
| "Show me notes related to neuro-vault.md"    | `get_similar_notes({ path: "Projects/neuro-vault.md" })`                                                                             |
| "Read today's daily note"                    | `read_daily()`                                                                                                                       |
| "Append a TODO to today"                     | `read_daily()` → `edit_note({ path, content: body + "- [ ] new todo" })` (see vault-operations)                                      |

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
