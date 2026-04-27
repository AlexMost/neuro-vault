# Routing Between Tools

Tool routing and retrieval policy are related, but not the same thing. Routing is about _which tool to call_; retrieval policy is about _what happens once `search_notes` is called_.

## Rules of thumb

- Use **structural tools** first — your assistant's own file/path/title tools, or vault operations like `read_note`, `read_property`, `get_tag` — for exact file, title, path, daily note, tag, property, wikilink, backlink, and link-traversal requests.
- Use `search_notes` for fuzzy topic, concept, and semantic retrieval.
- Use `get_similar_notes` after you already have a relevant note and want semantic expansion.
- Treat the routing guidance as **behavior, not enforcement**; the server does not hard-block other tool choices.
- Use semantic retrieval to find likely notes, then switch to structural tools when you need exact anchors.

## Examples

| User asks                                    | Tool to use                                                  |
| -------------------------------------------- | ------------------------------------------------------------ |
| "Read the note 'Q1 OKRs'"                    | `read_note({ name: "Q1 OKRs" })`                             |
| "What's the status of Quarterly review?"     | `read_property({ name: "Quarterly review", key: "status" })` |
| "Show me all notes tagged #mcp"              | `get_tag({ tag: "mcp" })`                                    |
| "What did I write about building AI agents?" | `search_notes({ query: "building AI agents" })`              |
| "Tell me everything I know about embeddings" | `search_notes({ query: "embeddings", mode: "deep" })`        |
| "Show me notes related to neuro-vault.md"    | `get_similar_notes({ path: "Projects/neuro-vault.md" })`     |
| "Read today's daily note"                    | `read_daily()`                                               |
| "Append a TODO to today"                     | `append_daily({ content: "- [ ] new todo" })`                |

## Tag-driven questions are exact, not fuzzy

For "which notes are tagged X?" or "show me everything in #ai", use `get_tag` rather than `search_notes`. The answer is precise (a list maintained by Obsidian itself) and skipping `search_notes` saves an embedding round-trip.
