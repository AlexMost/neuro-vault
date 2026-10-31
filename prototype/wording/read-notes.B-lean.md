Read one or more notes in one call — whole, or one heading block or line range of each. Direct from disk; Obsidian need not run.

`paths`: one item or 1–50. An item is a path string (whole note), `{ path, heading }` (a heading block, by the heading name an outline lists) or `{ path, lines: [start, end] }`. One selector per item; repeat a path for several parts. Exact duplicates dropped; input order kept.

`lines` everywhere (here and in `search_notes`) is file-relative, 1-based, inclusive, frontmatter counted. A `lines` selector is clipped to the body.

`content` applies to each item's selection: `frontmatter` → frontmatter only; `outline` → + `lines`, `preamble`, `outline: [{ heading, level, lines }]` (no text); `preview` → + the first 500 chars and `truncated`; `full` → frontmatter, `lines`, whole text. Default: selector item → `full`; bare path → `full` if the call has one item, else `preview`.

`collapsed: true` means the outline dropped its deepest levels; `hidden: n` = n sub-headings not listed — list them with `{ path, heading }` + `content: 'outline'`.

Misses are per item, with `error.code` and retry data: `HEADING_NOT_FOUND` (+ `outline`), `AMBIGUOUS_MATCH` (+ `matches`, read one by `lines`), `LINES_OUT_OF_RANGE` (+ body `lines`), `NOT_FOUND`. Frontmatter comes back on successful items.

From a search hit: `{ path, lines: row.lines }`.
