# Note Structure (read-time heading projection)

How `read_notes` sees a note's heading blocks, and the line coordinates it reports them in. The decision behind both — the chunker's heading model, run at read time, with the line numbers search already reports — is [ADR-0024](../adr/0024-structural-reads-share-search-coordinates.md).

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

1. `entriesWithin(structure, span)` keeps the heading blocks whose heading line lies inside `span`, in source order, each with its true span — never clipped to `span`. The outline mode passes the body span, so every heading block is listed.
2. `collapseOutline(entries)` bounds the list (below).

The item carries `lines` (the body span), `preamble` when the structure has one, `outline` and `collapsed` when something was dropped. An outline entry is `{ heading, level, lines }`, plus `hidden` on a collapsed outline.

A heading's own text (its lines before the first sub-heading) is not an entry, but the outline determines it: from the entry's `lines[0]` to the next entry's `lines[0] − 1` when that next entry starts inside the entry's span, and the whole entry otherwise.

## Collapse

An outline lists at most `OUTLINE_ENTRY_CAP` (100) entries before it collapses by **nesting depth**. An entry's depth is the number of other entries whose span contains it — containment, not `#` count, so a `###` directly under a `#` has depth 1.

- While more than 100 entries remain and more than one depth is left, every entry at the deepest remaining depth is dropped.
- The shallowest depth is never dropped. A note with 150 top-level headings and nothing under them lists all 150.
- Each dropped entry counts toward `hidden` of its **nearest kept ancestor only**. Every ancestor at a kept depth is kept, so that ancestor is at the deepest kept depth: `hidden` sits on the deepest kept entries, and `hidden: n` means n headings below the entry, at every depth, are not listed.
- The item carries `collapsed: true` only when at least one entry was dropped. An outline that fits carries neither `hidden` nor `collapsed`.

A dropped entry always has a kept ancestor, because depth 0 is kept and contains every deeper entry; `collapseOutline` throws if that ever fails to hold.

## Known limitation: a leading byte-order mark

A file that starts with a UTF-8 BOM (`U+FEFF`) is projected as if it had neither frontmatter nor a first-line heading. The frontmatter grammar (`splitRawFrontmatter`) needs `---` at the very start of the file, and the ATX check reads the raw line, which begins with the BOM. The fence and its YAML therefore count as body, and a heading on line 1 opens no block, so its lines fall into the preamble. The lexical leg differs in half of this: it shares the frontmatter grammar, so the fence is hidden from it too, but its markdown parser strips the BOM, so it still sees the first-line heading. Line numbers are not shifted — the BOM sits inside line 1.

## What it deliberately does not do

- It does not read the corpus, and it never embeds. An outline read costs one markdown parse of the body, the same parse the indexer runs; a `full` read costs none.
- It does not replace the lexical parser. Search keeps the lexical leg's wider heading set; only reads and semantic evidence share this model.
- It does not interpret Obsidian block references (`^id`) or `note.md#Heading` links.
