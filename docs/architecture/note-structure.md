# Note Structure (read-time heading projection)

How `read_notes` sees a note's heading blocks, the line coordinates it reports them in, and how it resolves a selection of one note. The decision behind the first two — the chunker's heading model, run at read time, with the line numbers search already reports — is [ADR-0024](../adr/0024-structural-reads-share-search-coordinates.md).

## What it is

`noteStructure(raw)` in `src/lib/obsidian/corpus/note-structure.ts` is a pure projection of a note's raw text onto its heading blocks. It returns:

| Field            | What it holds                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `lines`          | every line of the file, from `splitNoteLines`; index `i` is file line `i + 1`                                                                 |
| `frontmatterEnd` | the line of the closing frontmatter fence, `0` when the note has none (the chunker's `frontmatterEnd`)                                        |
| `body`           | the body span, `[frontmatterEnd + 1, last line]`, or `null` when no line follows the frontmatter                                              |
| `preamble`       | the span of the text before the first heading block (or to the end of a note without one), only when that text is non-blank; otherwise `null` |
| `headings`       | the heading blocks in source order, each `{ heading, level, lines }`                                                                          |

It lives beside the chunker (`src/lib/obsidian/corpus/chunker.ts`) and takes everything from the chunker's own helpers: `splitNoteLines`, `frontmatterEnd`, `headingBlocks` and `preambleSpan`. `chunkNote` builds the corpus's blocks from the same `headingBlocks` call, so a heading block has the same span and the same name in a search result's semantic `blocks[]` evidence and in a read. The projection keeps the heading blocks only. It drops the three other block kinds the chunker embeds: the frontmatter block, the preamble block and the numbered paragraph blocks of a heading's own text. It keeps the heading `level` (1–6), which the corpus does not store.

The projection runs on the file at read time and never touches the corpus. The stored corpus could not serve reads: it keeps only the blocks worth embedding, about two thirds of a vault's heading blocks.

## Which headings open a heading block

The chunker's rules, unchanged:

- **Root-level ATX headings only** — `#` to `######` on a line that is a direct child of the document. A setext heading, and a heading inside a list item, a blockquote, a code block or an HTML block, opens no block; its lines belong to the heading block around it, or to the preamble.
- **A heading with empty text (`#` alone) opens no block.**
- **The name is the source text**, after the `#` run and its one whitespace, trimmed — never the rendered text. `# **Bold** title` is named `**Bold** title`.
- **A heading block runs from its heading line to the line before the next heading of the same or a higher level**, or to the note's last line. Sub-headings are inside it, so a parent's span and its children's spans overlap.

The lexical leg of `search_notes` parses headings its own way (any mdast heading, setext and nested ones included; see [`lexical-search.md`](./lexical-search.md)), so its `heading` label can name a heading that opens no block here.

## Heading names

A heading's name is its text, plus a `[n]` suffix when the plain text would repeat a name already minted under the same parent heading. Headings under different parents are never suffixed against each other: `# P` → `## Notes` and `# Q` → `## Notes` are both `Notes`.

The suffix does more than count occurrences. `headingBlocks` keeps the name unique against **every block key already minted in the note** — the frontmatter key, other headings' keys, and the keys of numbered paragraph blocks — and counts on until the key is free. So `[n]` is usually the occurrence count, but not always:

- `# A`, `# A[2]`, `# A` name the third heading `A[3]`: `A[2]` is already taken by the second heading's literal text.
- In a note with frontmatter, a body heading titled `# ---frontmatter---` is named `---frontmatter---[2]`, because the frontmatter block's key already holds the plain name.

The name a read reports is therefore always the one a semantic `blocks[].heading` carries for the same block.

## Coordinates

Every span is `[start, end]`: **file-relative, 1-based, inclusive**, with frontmatter lines counted. A note whose frontmatter fence closes on line 3 has a body starting on line 4. These are the numbers `search_notes` evidence `lines` already reports, so one block has one coordinate pair across both tools.

`splitNoteLines` is the one line splitter for the chunker and the projection. It treats a trailing newline as the end of the last line rather than the start of an empty one, so no span reaches past the note's last real line. That fix came with `EMBED_VERSION` 3 (see [`own-corpus.md`](./own-corpus.md)).

Returned text is never line-numbered: `content` stays verbatim, so it can be pasted into `edit_note` `replace`. The coordinates travel beside the text, in `lines`.

## The body span

The body span is `[frontmatterEnd + 1, last line]`. Blank lines count. It is `null` for an empty file and for a note that is frontmatter only, and an item with no body span carries no `lines` field.

`read_notes` echoes the span as the item's `lines`:

- **`full`** echoes the span of the text it returns. It computes it in `fullSpan` (`src/modules/operations/tools/read-notes.ts`) from `frontmatterEnd` and `splitNoteLines` alone, without the markdown parse `noteStructure` runs, so the default single-note read stays cheap. When the frontmatter fence holds YAML that is malformed or does not parse to a mapping, the reader returns `frontmatter: null` and the whole raw file as `content`, so `lines` is `[1, last line]`.
- **`outline`** echoes `noteStructure`'s `body`. The fence still delimits the frontmatter there, malformed YAML or not, so `lines` starts after it.

Outside that malformed-YAML `full` read, the frontmatter ends on `lines[0] − 1` (line 0 when the note has none).

## The outline

`content: 'outline'` turns a structure into the item's `outline` in `src/modules/operations/outline.ts`:

1. `entriesWithin(structure, span)` keeps the heading blocks whose heading line lies inside `span`, in source order, each with its true span — never clipped to `span`. A whole-note outline passes the body span, so every heading block is listed; an outline of a [selection](#selections) passes the selection's span.
2. `collapseOutline(entries)` bounds the list (below).

The item carries `lines` (the body span, or the selection's span), `preamble` when the note's preamble overlaps that span with non-blank text (`preambleWithin`), `outline` and `collapsed` when something was dropped. An outline entry is `{ heading, level, lines }`, plus `hidden` on a collapsed outline.

A heading's own text (its lines before the first sub-heading) is not an entry, but the outline determines it: from the entry's `lines[0]` to the next entry's `lines[0] − 1` when that next entry starts inside the entry's span, and the whole entry otherwise.

## Collapse

An outline lists at most `OUTLINE_ENTRY_CAP` (100) entries before it collapses by **nesting depth**. An entry's depth is the number of other entries whose span contains it — containment, not `#` count, so a `###` directly under a `#` has depth 1.

- While more than 100 entries remain and more than one depth is left, every entry at the deepest remaining depth is dropped.
- The shallowest depth is never dropped. A note with 150 top-level headings and nothing under them lists all 150.
- Each dropped entry counts toward `hidden` of its **nearest kept ancestor only**. Every ancestor at a kept depth is kept, so that ancestor is at the deepest kept depth: `hidden` sits on the deepest kept entries, and `hidden: n` means n headings below the entry, at every depth, are not listed.
- The item carries `collapsed: true` only when at least one entry was dropped. An outline that fits carries neither `hidden` nor `collapsed`.

A dropped entry always has a kept ancestor, because depth 0 is kept and contains every deeper entry; `collapseOutline` throws if that ever fails to hold.

## Selections

A `read_notes` item may name a **selection** — `{ path, heading }` for one heading block, or `{ path, lines: [start, end] }` for one line range; a bare path selects the whole body. `src/modules/operations/selection.ts` turns the request into items and resolves each selector against the note's structure.

**Items.** `toRequestItems` maps each `paths` item to `{ path, selector }`, where the selector is `whole`, `heading` or `lines`; `{ path }` with no selector is the bare path. The input gate has already rejected a blank `heading`, a `lines` value that is not two integers with `1 ≤ start ≤ end`, and any other item key, as `INVALID_PARAMS`. What the schema cannot express — `heading` and `lines` on one item — throws `INVALID_ARGUMENT` here and fails the whole call. Items are de-duplicated exactly on the path as sent plus the selector (`itemKey`), before normalization, and keep input order. A note named by several items is read from disk once.

**Mode.** `effectiveMode` picks each item's `content` mode: an explicit `content` applies to every item; without one, a selector item reads `full`, and a bare path reads `full` only when it is the call's one item (counted after de-duplication, selector items included) and `preview` otherwise.

**Resolution.** `resolveSelector(structure, selector, path)` returns either the selection's span (plus the heading name and level for a heading selection) or a miss.

- **`lines`** is clipped to the body at both ends: `[max(start, body[0]), min(end, body[1])]`. A partial overlap resolves to the clipped span, which the item echoes as `lines`. Only a range that shares no line with the body — wholly inside the frontmatter, or past the last line — is `LINES_OUT_OF_RANGE`, and so is every range on a note with no body span.
- **`heading`** matches the heading names of `structure.headings` exactly first. Only when no name matches exactly does it compare `normalizeHeadingName` forms: NFC, a leading `#{1,6}` and its whitespace dropped, wikilinks and Markdown links reduced to their display text, emphasis and code markup (`*`, `_`, backticks) removed, whitespace collapsed, trimmed, then case-folded (upper, then lower case, so non-Latin names compare and `ß` meets `SS`). One hit resolves to that heading block's span; none is `HEADING_NOT_FOUND`; several are `AMBIGUOUS_MATCH`. Level is ignored, a prefix never matches, and every heading block counts, including one a collapsed outline does not list. Exact matching first is what makes `Notes` and `Notes[2]` two distinct addresses.

**Rendering.** A resolved selection renders in the item's mode: `full` returns the span's text verbatim (`spanText`; on a CRLF note the interior line endings stay CRLF and the last line's `\r` is dropped), `outline` lists the heading blocks inside the span (above) with the collapse counted within it, `preview` carries those same outline fields plus `previewBody` of the span's text — a prefix that starts at the span's first line — and `frontmatter` returns only the frontmatter. Every mode but `frontmatter` echoes the span as `lines`, plus `heading` and `level` for a heading selection. The selector is resolved in every mode, so a miss is the same item in each. A bare-path `preview` takes `previewBody` of the reader's `content` instead — the body, or the raw file when its YAML does not parse — so it equals `previewBody` of what `full` returns; its outline fields are those of `outline` over the body. A selection's text, in `full` or `preview`, never ends in a dangling `\r`: `spanText` drops the last one, and `previewBody` trims before its marker.

**Misses.** A miss fails its item only. The item is `{ path, error: { code, message } }` plus retry data, and never carries `frontmatter`:

| Code                 | Retry data                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `HEADING_NOT_FOUND`  | body `lines` (when the note has a body) + the whole-note `outline`, collapsed, + `collapsed` |
| `AMBIGUOUS_MATCH`    | `matches: [{ heading, level, lines }]` — every heading block the name matched                 |
| `LINES_OUT_OF_RANGE` | body `lines` (when the note has a body)                                                      |

Each message states the cause and the retry: a range in the frontmatter points to `content: 'frontmatter'` (or, when the fence's YAML does not parse and a frontmatter read returns `null`, to a whole-note `content: 'full'` read, which returns the fence as text), a heading miss on a note without headings points to `{ path, lines }`, and a miss on an empty or frontmatter-only note says so. An unsafe path stays a per-item `INVALID_ARGUMENT`, and a missing note a per-item `NOT_FOUND`, as for a bare path.

**Search hand-off.** Every body block of the corpus and every lexical body or heading match carries `lines` in these coordinates, so `{ path, lines: row.lines }` returns exactly the evidence row's text from the unchanged note. The frontmatter block (`---frontmatter---`) lies outside the body: its `lines` are `LINES_OUT_OF_RANGE`, and it is read as `{ paths: [path], content: 'frontmatter' }`. A semantic block with a non-empty `heading` other than that reads the same span through `{ path, heading }`. A lexical `heading` comes from the lexical parser's wider heading set (above), so it is a label, not an address.

## Known limitation: a leading byte-order mark

A file that starts with a UTF-8 BOM (`U+FEFF`) is projected as if it had neither frontmatter nor a first-line heading. The frontmatter grammar (`splitRawFrontmatter`) needs `---` at the very start of the file, and the ATX check reads the raw line, which begins with the BOM. The fence and its YAML therefore count as body, and a heading on line 1 opens no block, so its lines fall into the preamble. The lexical leg differs in half of this: it shares the frontmatter grammar, so the fence is hidden from it too, but its markdown parser strips the BOM, so it still sees the first-line heading. Line numbers are not shifted — the BOM sits inside line 1.

## What it deliberately does not do

- It does not read the corpus, and it never embeds. An outline read costs one markdown parse of the body, the same parse the indexer runs; a `full` read costs none.
- It does not replace the lexical parser. Search keeps the lexical leg's wider heading set; only reads and semantic evidence share this model.
- It does not interpret Obsidian block references (`^id`) or `note.md#Heading` links. A `heading` selection takes a heading name, not a link.
