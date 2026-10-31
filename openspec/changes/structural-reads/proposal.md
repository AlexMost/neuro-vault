Tracked by: #239

## Why

`read_notes` has only `full`, a 500-char `preview` prefix, and `frontmatter`. To use one heading
block of a long note, a model reads the whole body, and the batch default often shows nothing
past the first few headings: on a ~1k-note vault the prefix reaches at most half the headings of
452 of 805 multi-heading notes. `search_notes` already hands out block `lines` and `heading`
evidence that no read can use. Structural reads close that gap: see the structure first, then
read exactly the selection needed (#152, #189, #239).

## What Changes

**`paths` items**
- From: `paths` is a path string or an array of path strings.
- To: an item is `string | { path, heading?, lines? }`, with at most one selector per item, a
  50-item cap counting reads, and exact de-duplication. A mixed array sent as a JSON string, and
  numeric strings in `lines`, are coerced at the gate.
- Reason: each search hit names its own block. One item → one selection → one span.
- Impact: non-breaking. Strings and string arrays behave as today.

**Content modes**
- From: `full` / `preview` / `frontmatter`, with the default `full` for one distinct path and
  `preview` for more.
- To: adds `outline` (a flat `{ heading, level, lines }` list, collapsing past 100 entries with
  `hidden` / `collapsed`). `content` applies to each item's *selection*. The default is per
  item: a selector item gets `full`; a bare path gets `full` in a one-item call and `preview`
  otherwise.
- Reason: a model needs to see a note's structure before it reads any part of it.
- Impact: non-breaking. An explicit `content` keeps working.

**`preview`**
- From: a 500-char prefix + `truncated`.
- To: the same prefix and `truncated`, byte-identical, plus `lines` (the body span), `preamble`,
  `outline` and `collapsed`.
- Reason: the batch default should show the structure (#189).
- Impact: non-breaking. A preview item grows from ~0.9 KB to ~1.8 KB at p95.

**Line coordinates and the span echo**
- To: file-relative, 1-based and inclusive, frontmatter counted, the same coordinates as search
  evidence. Every item that returns body text echoes its span in `lines`. A heading read also
  echoes `heading` and `level`. A `lines` range is clipped to the body.
- Impact: additive fields.

**Selector misses**
- To: per-item errors `HEADING_NOT_FOUND`, `AMBIGUOUS_MATCH` and `LINES_OUT_OF_RANGE`, each
  carrying retry data on the item (`outline`, `matches` or body `lines`). Malformed arguments
  fail the whole call: `INVALID_PARAMS` at the gate, and `INVALID_ARGUMENT` for `heading` +
  `lines` on one item.
- Impact: the error-code union widens additively.

**Chunker line spans**
- From: a file ending in `\n` gives its last block a span one line past the real last line.
- To: the span ends on the last real line. `EMBED_VERSION` goes 2 → 3, so the corpus rebuilds
  once on upgrade.
- Reason: reads and search must report one coordinate pair per block.
- Impact: a one-time re-embed. Search evidence `lines` on the last block shrink by one.

**Descriptions and guide**
- To: a sectioned `read_notes` description (~4.6 KB), and two `search_notes` RESPONSE SHAPE
  lines teaching the `{ path, lines }` hand-off. The guide gains coordinates, the outline,
  misses and the hand-off.

## Capabilities

### New Capabilities
- `read-notes-selections`: `paths` items with a `heading` or `lines` selector, heading-name
  matching, line coordinates and clipping, the span echo, and the selector misses with their
  retry data.

### Modified Capabilities
- `read-notes-content-modes`:
  - the `content` enum gains `outline`;
  - the default becomes per item;
  - `preview` gains the outline fields;
  - "frontmatter is always returned" applies to successful items only;
  - `content` applies to a selection.
- `embed-text-extraction`: a block's line span ends on the note's last real line. A trailing
  newline adds no line.

## Impact

- **Code:**
  - `src/modules/operations/tools/read-notes.ts`, `src/modules/operations/types.ts` and
    `src/modules/operations/preview-body.ts`;
  - a read-time heading projection beside `src/lib/obsidian/corpus/chunker.ts`;
  - `src/lib/input-coercion.ts`;
  - `EMBED_VERSION` in `src/lib/obsidian/corpus/types.ts`;
  - in `search_notes`, the description only.
- **API:** additive. The parameter dictionary gains `heading` and `lines` as `paths`-item
  fields, and `content` gains `outline`.
- **Docs:**
  - `docs/guide/{reading-and-modifying,finding-notes,routing}.md`;
  - `docs/architecture/{mcp-parameter-dictionary,input-coercion,own-corpus}.md`;
  - a new `docs/architecture/note-structure.md`;
  - one new ADR;
  - `GLOSSARY.md`.
- **Operations:** one corpus rebuild per vault on upgrade.
- **Delivery:** four PRs (foundation → outline → selections → preview). This change closes #239,
  #152 and #189 in its last PR.
