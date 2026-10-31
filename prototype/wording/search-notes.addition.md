Added to the `search_notes` description, RESPONSE SHAPE section (after the `matches[]` line):

- Evidence `lines` (`blocks[].lines`, `lexical[].lines`) is `[start, end]`, file-relative, 1-based, inclusive — frontmatter lines counted, the same coordinates `read_notes` takes. Read a hit with `read_notes({ paths: [{ path, lines }] })`.
- `blocks[].heading` is a heading name, readable as `{ path, heading }` when non-empty; `""` marks a paragraph or preamble block. `lexical[].heading` is the nearest heading's text, a label only.
