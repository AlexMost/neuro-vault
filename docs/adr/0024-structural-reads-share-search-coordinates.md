# ADR-0024 — Structural reads use the chunker heading model at read time, with the line coordinates search reports

- **Status**: Accepted
- **Date**: 2026-10-31

## Context

`read_notes` returned a note whole, as a 500-character prefix, or as frontmatter alone; it had no notion of the note's structure (#239, #152, #189). Giving it one meant choosing a heading model and a line convention, and the repo already had two of each that disagreed:

- **Two heading parsers.** The corpus chunker (`src/lib/obsidian/corpus/chunker.ts`) takes root-level ATX headings only, gives each heading block its whole subtree as a span, and names repeated siblings `Title[2]`. Its output is stored verbatim as semantic `blocks[]` evidence. The lexical parser (`src/lib/obsidian/lexical/blocks.ts`) takes any mdast heading, setext and nested ones included, and labels a match with the nearest preceding heading's text.
- **Two line conventions, neither written down.** Search evidence `lines` are file-relative with frontmatter counted. `read_notes` `content` is the body with frontmatter stripped.
- **A phantom line.** The chunker split on `\n`, so a note ending in a newline gained an empty last line and the last block's span ended one past the real last line.

The main path a model takes is search → read: it finds a block through `search_notes` and wants that block back. Any translation on that hand-off is a place for it to be off by the frontmatter's height or by one line.

## Decision

**Reads use the chunker's heading model, run on the file at read time.** `noteStructure` (`src/lib/obsidian/corpus/note-structure.ts`) projects a note onto the heading blocks of the chunker's `headingBlocks` — the same call `chunkNote` builds the corpus from — and keeps the heading `level`. A heading block's span and heading name are therefore identical in a read and in a semantic `blocks[]` row. Reads do not consult the stored corpus.

**Every line coordinate `read_notes` emits or accepts is file-relative, 1-based and inclusive, with frontmatter counted** — the convention search evidence already uses. Returned text stays verbatim, with no line prefixes; each item that returns body coordinates echoes its span as `lines`, and a whole-note item's span is the body span, so frontmatter ends on `lines[0] − 1`. A line range taken from a search hit reads back with no translation.

**The phantom line is fixed at its source.** `splitNoteLines` is the one line splitter of the chunker and the projection, and it treats a trailing newline as a terminator. `EMBED_VERSION` goes from 2 to 3 so stored corpora rebuild with the corrected spans instead of disagreeing with reads by a line until each note changes.

The detailed rules — heading names, the body span, the outline and its collapse — are in [`note-structure.md`](../architecture/note-structure.md).

## Consequences

- **`embed_version` 3.** The identity mismatch discards and re-embeds every vault's corpus once on upgrade, and the release's CHANGELOG entry says so. Until a corpus is rebuilt, stale evidence can end one line past a note's end.
- **Two tools share one contract.** The chunker's heading rules and the coordinate convention are now part of both `search_notes` and `read_notes`. Changing either — admitting setext headings, renumbering siblings, counting from the body — is a breaking change to both, and a chunker change that moves a span is a read-contract change too.
- **The coordinates surprise without context.** `content` omits the frontmatter, yet its `lines` count it. The tool description and the guide state the rule and the `lines[0] − 1` identity, since nothing in the text itself shows the offset.
- **The lexical parser stays as it is.** Search keeps its wider heading set. Its `heading` is a label, not an address of a heading block. On a ~1,000-note vault the two models diverge on 0.5% of notes (headings inside list items), and none of those shifts a chunker span.
- **Reads inherit the chunker's limits.** A setext heading or a heading in a list opens no heading block in a read either, and a leading UTF-8 BOM hides the frontmatter fence and a first-line heading from both.
- **An outline read parses the note.** It is one linear mdast pass, the same one the indexer runs. A `full` read derives its span without it.

## Alternatives considered

- **Body-relative coordinates** — they match `content`, but search evidence is file-relative, so every hand-off would need a translation. They buy stability nowhere it matters: a frontmatter edit shifts search evidence anyway.
- **Both systems, with an offset** — two numbers per block that differ by the frontmatter's height are easy to confuse, and a model that picks the wrong one reads the wrong lines without an error.
- **The lexical heading model** — it would give reads a second set of coordinates beside search: its headings and spans are not the ones semantic evidence cites.
- **Serving reads from the stored corpus** — it keeps only the blocks worth embedding, about 68% of heading blocks, so it cannot list a note's structure.
- **Line-numbered text** — it puts the coordinates in the text, but the text can then no longer be pasted into an exact-string edit.
- **No `EMBED_VERSION` bump** — shards would heal only as notes change, and search and reads would disagree by a line on the same block in the meantime.
