# read-notes-content-modes Specification

## Purpose

TBD - created by archiving change read-notes-preview. Update Purpose after archive.
## Requirements
### Requirement: read_notes selects body granularity via a `content` mode

`read_notes` SHALL accept an optional `content` parameter with exactly the values `'full'`,
`'outline'`, `'preview'`, or `'frontmatter'`, as one value for the whole call; `content` SHALL
NOT be accepted inside a `paths` item. When `content` is omitted, the effective mode SHALL be
derived per item, after exact de-duplication of the request items (see `read-notes-selections`):
an item carrying a selector SHALL default to `'full'`; a bare-path item SHALL default to `'full'`
when the call has exactly one item and to `'preview'` when it has two or more, counting every
item, selector items included. An explicitly supplied `content` value SHALL apply to every item
and SHALL always take precedence over this default. `read_notes` SHALL NOT expose a `fields`
parameter. `paths` semantics (string-or-array, 1–50 items, exact de-duplication, input order,
per-item errors) are otherwise as `read-notes-selections` states.

Argument shape — the `content` enum, the `paths` union and its 1–50 bound, and every
selector-field constraint a schema can express — SHALL be enforced by the tool's declared input
schema at the registration gate, so a violation fails with `INVALID_PARAMS` before the handler
runs. `read_notes` SHALL NOT re-check any of these post-gate; `INVALID_ARGUMENT` is reserved for
faults the schema cannot express: per-item path faults (traversal, absolute paths) and a `paths`
item that carries both `heading` and `lines`.

#### Scenario: a single path defaults to the full body

- **WHEN** `read_notes` is called with exactly one distinct path and no `content` parameter
- **THEN** the successful item returns `{ path, frontmatter, content, lines }` with the complete
  body, `lines` its body span, and no `truncated` field

#### Scenario: multiple paths default to preview

- **WHEN** `read_notes` is called with two or more distinct bare paths and no `content` parameter
- **THEN** each successful item returns frontmatter plus a preview (prefix, `truncated`, and the
  outline fields)

#### Scenario: duplicate of a single path still counts as one

- **WHEN** `read_notes` is called with the same path repeated and no `content` parameter
- **THEN** the request is treated as one item and defaults to `'full'`

#### Scenario: a selector item defaults to full in a multi-item call

- **WHEN** `read_notes` is called with `paths: ['a.md', { path: 'b.md', lines: [10, 20] }]` and no
  `content` parameter
- **THEN** the `a.md` item is a preview and the `b.md` item returns lines 10–20 in full

#### Scenario: selector items count toward the bare-path default

- **WHEN** `read_notes` is called with `paths: ['a.md', { path: 'a.md', heading: 'Notes' }]` and no
  `content` parameter
- **THEN** the call has two items, so the bare `a.md` item is a preview

#### Scenario: explicit `content` overrides the derived default

- **WHEN** `read_notes` is called with `content: 'full'` and two or more paths, **OR** with
  `content: 'preview'` and a single path
- **THEN** the explicit mode is applied to every item regardless of the item count or selectors

#### Scenario: `content: 'frontmatter'` returns frontmatter only

- **WHEN** `read_notes` is called with `content: 'frontmatter'`
- **THEN** each successful item returns `{ path, frontmatter }` with no `content`, `truncated`,
  `lines`, `heading`, `level`, or `outline` field

#### Scenario: an invalid `content` value is rejected

- **WHEN** `read_notes` is called with a `content` value other than `'full'`, `'outline'`,
  `'preview'`, or `'frontmatter'` (e.g. `'none'`)
- **THEN** the call SHALL fail with an `INVALID_PARAMS` error naming the `content` field and the
  four allowed values

#### Scenario: `content` inside an item is rejected

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', content: 'full' }]`
- **THEN** the call SHALL fail with `INVALID_PARAMS` reporting `content` as an unrecognized key of
  the item

#### Scenario: an out-of-range `paths` argument is rejected at the gate

- **WHEN** `read_notes` is called with `paths` as an empty string, an empty array, or an array of
  more than 50 items
- **THEN** the call SHALL fail with `INVALID_PARAMS` identifying `paths`, not with
  `INVALID_ARGUMENT`

#### Scenario: a legacy `fields` parameter is rejected

- **WHEN** `read_notes` is called with a `fields` key (the removed parameter)
- **THEN** the call SHALL fail with `INVALID_PARAMS` reporting `fields` as an unrecognized key,
  consistent with the `tolerant-arguments` requirement that unknown keys remain rejected

#### Scenario: a stringified `paths` array is accepted

- **WHEN** `read_notes` is called with `paths` set to the string `'["a.md","b.md"]'`
- **THEN** the gate SHALL parse it to `['a.md', 'b.md']` and the call SHALL proceed with two items

### Requirement: Frontmatter is always returned regardless of mode

`read_notes` SHALL include each successful item's parsed `frontmatter` in `'full'`, `'outline'`,
`'preview'`, and `'frontmatter'` modes. There SHALL be no mode that returns a body or an outline
without frontmatter. An error item — a missing or unreadable note, or a selector miss — SHALL NOT
carry `frontmatter`.

#### Scenario: frontmatter present in every mode

- **WHEN** `read_notes` is called for a note that has frontmatter, in each of `'full'`,
  `'outline'`, `'preview'`, and `'frontmatter'`
- **THEN** every successful item includes the `frontmatter` object

#### Scenario: a selector miss carries no frontmatter

- **WHEN** `read_notes` is called with `{ path: 'a.md', heading: 'Missing' }` for a note with
  frontmatter and no such heading block
- **THEN** the item carries `error` and no `frontmatter` field

### Requirement: `preview` returns a bounded, boundary-cut body slice with a truncation signal

In `'preview'` mode, `read_notes` SHALL return frontmatter plus a deterministic, length-bounded
slice of the item's selection, marked by a boolean `truncated` field, together with the outline
fields of `'outline'` mode for the same selection: `lines`, `preamble` when non-blank, `outline`,
and `collapsed` when the outline was collapsed. The slice SHALL start at the selection's first
line (the body's first line for a bare path). When the selection's text is at or under the
preview bound, it SHALL be returned unchanged with `truncated: false`. When it exceeds the bound,
the returned `content` SHALL be that text truncated at a word/line boundary at or before the
bound, with a truncation marker appended, and `truncated: true`. For a bare path, `content` and
`truncated` SHALL be identical to what this mode returned before the outline fields were added.

#### Scenario: short body is returned intact

- **WHEN** `read_notes` resolves a note to `'preview'` mode and the note's body is at or under the
  preview bound
- **THEN** the item returns the complete body unchanged with `truncated: false`, and the outline
  fields are still present

#### Scenario: long body is truncated and flagged

- **WHEN** `read_notes` resolves a note to `'preview'` mode and the note's body exceeds the
  preview bound
- **THEN** the item returns a body slice no longer than the bound (plus marker), cut on a
  word/line boundary, ending in the truncation marker, with `truncated: true`

#### Scenario: truncation is deterministic

- **WHEN** `read_notes` resolves the same unchanged note to `'preview'` mode twice
- **THEN** the returned `content`, `truncated`, and outline fields are identical across both calls

#### Scenario: preview carries the note's outline

- **WHEN** `read_notes` resolves a note with headings `## A` (lines 5–9) and `## B` (lines 10–14),
  after frontmatter ending on line 3, to `'preview'` mode
- **THEN** the item carries `lines: [4, 14]` and
  `outline: [{ heading: 'A', level: 2, lines: [5, 9] }, { heading: 'B', level: 2, lines: [10, 14] }]`

#### Scenario: a headless note previews with an empty outline

- **WHEN** `read_notes` resolves a note without headings to `'preview'` mode
- **THEN** the item carries `outline: []` and a `preamble` covering its non-blank body

### Requirement: `outline` returns a note's heading blocks without body text

In `'outline'` mode, `read_notes` SHALL return, for each successful item, `frontmatter`, the
selection's span as `lines`, `preamble: [start, end]` only when the note's text before its first
heading intersected with the selection is non-blank, and `outline`: a flat list, in source order,
of the heading blocks whose heading line lies inside the selection, each entry exactly
`{ heading, level, lines }` (plus `hidden` when collapsed). No body text SHALL be returned.
`heading` SHALL be the heading name — the heading's source text, plus a `[n]` suffix when an
earlier sibling under the same parent has the same text — `level` SHALL be the heading's `#`
count, and `lines` SHALL be the heading block's whole span, never clipped to the selection.
Heading blocks SHALL be those of the corpus chunker: ATX headings that are direct children of the
document root; a setext heading or a heading inside a list item, blockquote, code, or HTML block
SHALL NOT produce an entry.

#### Scenario: an outline lists heading blocks with their spans

- **WHEN** `read_notes` is called with `content: 'outline'` for a note whose frontmatter ends on
  line 3 and whose body holds `# Top` (line 5) with `## Inner` (line 8) and runs to line 12
- **THEN** the item carries `lines: [4, 12]` and
  `outline: [{ heading: 'Top', level: 1, lines: [5, 12] }, { heading: 'Inner', level: 2, lines: [8, 12] }]`
  and no `content` field

#### Scenario: a repeated sibling heading is named with its suffix

- **WHEN** a note has two `## Notes` headings under the same parent
- **THEN** their outline entries are named `Notes` and `Notes[2]`

#### Scenario: a heading inside a list item is not an entry

- **WHEN** a note contains a heading inside a list item
- **THEN** no outline entry is produced for it, and the enclosing heading block's span is unbroken

#### Scenario: an outline of a selection lists only its heading blocks

- **WHEN** `read_notes` is called with `content: 'outline'` and `{ path: 'log.md', heading: '2026-01' }`
- **THEN** the outline lists `2026-01` first and then only the heading blocks nested in it, each
  with its true span

### Requirement: A large outline collapses by depth

When a selection holds more than 100 heading blocks, `read_notes` SHALL drop the deepest
remaining nesting level of the selection's heading-block tree, repeatedly, until at most 100
entries remain or only the shallowest level is left; the shallowest level SHALL never be dropped.
Each entry at the deepest kept level whose sub-headings were dropped SHALL carry `hidden: <n>`,
the number of headings below it, at all depths, that are not listed, and the item SHALL carry
`collapsed: true`. An outline
that needed no collapse SHALL carry neither `hidden` nor `collapsed`. The same rule SHALL apply to
the outline fields of `'preview'` mode and to the `outline` retry data of a `HEADING_NOT_FOUND`
miss.

#### Scenario: a heading-dense note collapses its deepest level

- **WHEN** a note has 12 level-2 headings, each with 10 level-3 sub-headings (132 heading blocks
  under one `#` title), read with `content: 'outline'`
- **THEN** the outline lists the title and the 12 level-2 entries, each carrying `hidden: 10`, and
  the item carries `collapsed: true`

#### Scenario: more than 100 top-level headings are all kept

- **WHEN** a note has 150 level-1 headings and nothing below them
- **THEN** all 150 entries are listed

#### Scenario: hidden headings are listed by drilling in

- **WHEN** an entry `2026-01` carries `hidden: 33`, and `read_notes` is called with
  `content: 'outline'` and `{ path, heading: '2026-01' }`
- **THEN** the outline lists `2026-01` and its sub-headings, collapsing only if they exceed 100

