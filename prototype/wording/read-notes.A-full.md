Read one or more notes in one call — whole, or one heading block or line range of each. Direct from disk; Obsidian need not run.

PATHS: one item or an array of 1–50. An item is a vault-relative path string (the whole note) or an object naming a selection: `{ path, heading: "<heading name>" }` (one heading block) or `{ path, lines: [start, end] }` (one line range). At most one selector per item; `{ path }` alone equals the string. To read several parts of one note, repeat the path. Exact duplicates are dropped; results keep input order.

LINE COORDINATES: every `lines` — in this tool's input and output and in `search_notes` evidence — is `[start, end]`, file-relative, 1-based, inclusive: frontmatter lines are counted, so the body starts after them, and frontmatter ends on the item's `lines[0] − 1`. A `lines` selector is clipped to the body: a partial overlap returns the overlapping lines, and the echoed `lines` shows what came back; only a range sharing no line with the body is a miss.

CONTENT is one value for the whole call, next to `paths` — `{ paths: [...], content: "outline" }` — never inside an item. It applies to each item's selection the way it applies to a whole note (the selection of a bare path is its body). Each rung shows more:
- `frontmatter`: `{ path, frontmatter }`.
- `outline`: frontmatter + `lines` (the selection's span; the body span for a whole note) + `preamble` (`[start, end]` of text before the first heading, only when non-blank) + `outline: [{ heading, level, lines }]` — heading blocks in source order. No body text.
- `preview`: everything in `outline` + `content` (the selection's first 500 chars, verbatim) + `truncated` (true when `content` stops before the selection's end).
- `full`: frontmatter + `lines` + `content` (the whole selection). A heading read also echoes the matched `heading` and its `level`.
Omitting `content`: a selector item returns its selection in `full`; a bare path returns `full` when the call has one item, `preview` otherwise.

READING THE OUTLINE:
- An entry's `lines` is its whole heading block: the heading line through the line before the next heading of the same or higher level, sub-headings included. A heading read returns exactly that span.
- `heading` is the heading name: pass it unchanged as `{ path, heading }`. `Notes[2]` (literally, as the `heading` value) is the second `Notes` directly under the same parent heading. Matching is exact, then case- and markup-insensitive if that finds exactly one block; never by prefix. A name that matches several blocks is `AMBIGUOUS_MATCH`.
- Own text (lines before the first sub-heading): from the entry's `lines[0]` to the next entry's `lines[0]` − 1 when that next entry starts inside the entry's `lines`; otherwise all of the entry. Read it with `{ path, lines }`.
- Over 100 entries, the deepest levels are dropped: the item carries `collapsed: true`, and `hidden: n` on an entry means n headings below it (all depths) are not listed. Hidden headings are still readable by name; list them by reading that entry's outline: `{ paths: [{ path, heading: "<the entry's heading>" }], content: "outline" }`.
- Preview `content` is raw text and may show headings that a collapsed outline does not list.

MISSES are per item; other items are unaffected. A missed item carries `error: { code, message }` plus retry data, and no `frontmatter`:
- `HEADING_NOT_FOUND`: + body `lines` + the note's `outline` — retry with a `heading` from it.
- `AMBIGUOUS_MATCH`: the name matches several heading blocks; + `matches: [{ heading, level, lines }]` — read the one you want with `{ path, lines }`.
- `LINES_OUT_OF_RANGE`: the range shares no line with the body; + body `lines`.
- `NOT_FOUND`: the note does not exist.
The whole call fails with `INVALID_ARGUMENT` for both selectors in one item, an empty `heading`, or malformed `lines` (two integers, 1 ≤ start ≤ end).
Successful items always carry parsed `frontmatter`. Before citing or editing, read the part you need in `full`.

FROM A SEARCH HIT: read any `search_notes` evidence row (a `blocks[]` or `lexical[]` entry) as `{ path, lines: row.lines }`. A semantic block with a non-empty `heading` also reads as `{ path, heading: row.heading }`. `heading: ""` marks a paragraph inside a heading block, or the preamble: it does not name the block around it, and passing `""` fails the call. A lexical `heading` is the nearest heading's text, a label only: as an address it can silently pick the wrong block — a bare `Notes` matches the first of sibling headings `Notes` and `Notes[2]` exactly, with no error. A heading read echoes its `lines`: if the hit's `lines` fall outside them, it read the wrong block. To get the heading block around a hit, read the outline and take the deepest entry whose `lines` contain the hit's.
