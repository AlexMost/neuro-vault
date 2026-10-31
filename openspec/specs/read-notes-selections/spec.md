# read-notes-selections Specification

## Purpose
How a `read_notes` `paths` item names one heading block or one line range of its note, in the file-relative, 1-based, inclusive coordinates that `search_notes` evidence uses, and how a selector that cannot be resolved comes back as a per-item miss with retry data.
## Requirements
### Requirement: A `paths` item may name a selection of its note

`read_notes` SHALL accept each `paths` item as either a path string or an object
`{ path, heading?, lines? }`, in any mix within one array; a single string SHALL remain accepted
for `paths` itself. An object without a selector SHALL behave exactly as the bare path string. An
item SHALL name at most one selection: the whole body (no selector), one heading block
(`heading`), or one line range (`lines`); several selections of one note SHALL be requested as
several items. The 1–50 bound SHALL count items. De-duplication SHALL collapse only exact
duplicates — the same path with the same selector — and results SHALL keep input order, one
result item per remaining request item.

#### Scenario: mixed string and object items are read in order

- **WHEN** `read_notes` is called with
  `paths: ['plain.md', { path: 'a.md', lines: [10, 20] }, { path: 'a.md', lines: [80, 95] }]`
- **THEN** the result holds three items in that order, the two `a.md` items each returning its own
  range

#### Scenario: a path and the same path with a selector are two reads

- **WHEN** `read_notes` is called with `paths: ['a.md', { path: 'a.md', lines: [10, 20] }]`
- **THEN** the result holds two items

#### Scenario: an exact duplicate item is read once

- **WHEN** `read_notes` is called with the item `{ path: 'a.md', heading: 'Notes' }` twice
- **THEN** the result holds one item

#### Scenario: an object without a selector equals the bare path

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md' }]`
- **THEN** the result is identical to calling it with `paths: ['a.md']`

### Requirement: The input gate coerces mixed and nested selector arguments

The registration gate SHALL parse a `paths` value sent as a JSON-encoded string into its array
form when that array mixes strings and objects, and SHALL coerce numeric strings inside a `lines`
pair to integers, before schema validation. Coercion SHALL NOT make an otherwise invalid value
valid in any other way.

#### Scenario: a stringified mixed array is accepted

- **WHEN** `read_notes` is called with `paths` set to the string
  `'["a.md",{"path":"b.md","lines":[3,9]}]'`
- **THEN** the gate parses it into a string item and an object item, and the call proceeds with
  two items

#### Scenario: numeric strings in `lines` are accepted

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', lines: ['10', '20'] }]`
- **THEN** the gate coerces the range to `[10, 20]` and the call proceeds

### Requirement: Selector arguments are validated for the whole call

`read_notes` SHALL fail the whole call, before reading any note, when a selector argument is
malformed. A `heading` that is empty or whitespace-only, and a `lines` value that is not exactly
two integers or whose start is below 1 or whose start exceeds its end, SHALL be rejected by the
input schema at the gate with `INVALID_PARAMS`; the message for an empty `heading` SHALL name
`{ path, lines }` as the way to read a block without a heading. An item carrying both `heading`
and `lines` SHALL fail the call with `INVALID_ARGUMENT`. A single-line range `[n, n]` SHALL be
valid.

#### Scenario: an empty heading fails the call at the gate

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', heading: '' }]`
- **THEN** the call fails with `INVALID_PARAMS`, and the message names `{ path, lines }`

#### Scenario: an inverted range fails the call at the gate

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', lines: [20, 10] }]`
- **THEN** the call fails with `INVALID_PARAMS`

#### Scenario: a range that is not two integers fails the call at the gate

- **WHEN** `read_notes` is called with `lines: [10]`, `lines: [10, 20, 30]`, `lines: [1.5, 3]`, or
  `lines: [0, 3]`
- **THEN** the call fails with `INVALID_PARAMS`

#### Scenario: two selectors on one item fail the call

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', heading: 'Notes', lines: [3, 9] }]`
- **THEN** the call fails with `INVALID_ARGUMENT`, and no note is read

#### Scenario: a one-line range is valid

- **WHEN** `read_notes` is called with `paths: [{ path: 'a.md', lines: [7, 7] }]` for a note whose
  body includes line 7
- **THEN** the item returns line 7 with `lines: [7, 7]`

### Requirement: Line coordinates are file-relative, 1-based, and inclusive

Every line number `read_notes` accepts or returns SHALL be file-relative, 1-based, and inclusive,
counting frontmatter lines — the same coordinates `search_notes` evidence uses. Every successful
item that returns body text SHALL echo the span of the text it returned as `lines`: the body span
`[first body line, last line]` for a whole-note item, and the returned span for a selection.
Returned text SHALL be verbatim, without line numbers. A `lines` selection SHALL be clipped to the
body at both ends — to the first line after frontmatter and to the note's last real line — and the
echoed `lines` SHALL show the clipped span.

#### Scenario: a full read echoes the body span

- **WHEN** `read_notes` reads a 40-line note whose frontmatter ends on line 4 with
  `content: 'full'`
- **THEN** the item carries `lines: [5, 40]` and the body text as it is in the file

#### Scenario: a range overlapping frontmatter is clipped

- **WHEN** `read_notes` is called with `{ path, lines: [2, 9] }` for a note whose frontmatter ends
  on line 4
- **THEN** the item returns lines 5–9 with `lines: [5, 9]`

#### Scenario: a range past the end is clipped

- **WHEN** `read_notes` is called with `{ path, lines: [30, 45] }` for a 40-line note
- **THEN** the item returns lines 30–40 with `lines: [30, 40]`

### Requirement: A heading selector reads one heading block by its heading name

A `heading` selector SHALL name a heading block by its heading name: the heading's source text,
plus a `[n]` suffix when an earlier sibling under the same parent has the same text — the string
outline entries and semantic `blocks[].heading` carry. Resolution SHALL try an exact match first.
Only when no heading name matches exactly SHALL it compare both sides normalized — case-folded,
whitespace collapsed, inline emphasis and code markup removed, wikilinks and Markdown links reduced
to their display text, and a leading run of `#` plus a space dropped — and accept the match only if
exactly one heading block matches. Heading level SHALL be ignored; prefix and substring matches
SHALL NOT match. A resolved heading read SHALL return the whole heading block — from the heading
line to the line before the next heading of the same or higher level, nested sub-headings included —
and SHALL echo `lines`, the resolved `heading` name as the outline prints it, and `level`.

#### Scenario: an exact heading name reads its whole block

- **WHEN** `read_notes` is called with `{ path, heading: 'Progress' }` for a note where `## Progress`
  spans lines 7–40 and contains `### Week 1`
- **THEN** the item returns lines 7–40, including `### Week 1`, with `lines: [7, 40]`,
  `heading: 'Progress'`, and `level: 2`

#### Scenario: a normalized name resolves to a unique block

- **WHEN** a note has the heading `## **Open** questions` and `read_notes` is called with
  `heading: 'open questions'`
- **THEN** the item returns that heading block and echoes `heading: '**Open** questions'`

#### Scenario: a sibling duplicate is addressed by its suffix

- **WHEN** a note has two `## Notes` headings under the same parent and `read_notes` is called
  with `heading: 'Notes[2]'`
- **THEN** the item returns the second `Notes` heading block

#### Scenario: a prefix does not match

- **WHEN** a note has the heading `## 2026-01-15 standup` and `read_notes` is called with
  `heading: '2026-01'`
- **THEN** the item is a `HEADING_NOT_FOUND` miss

### Requirement: A selector miss is a per-item error carrying retry data

When a selector cannot be resolved, `read_notes` SHALL return that item as an error item
`{ path, error: { code, message } }`, counted in `errors`, and SHALL NOT fail the other items or
return empty content. The codes SHALL be `HEADING_NOT_FOUND` when no heading block matches,
`AMBIGUOUS_MATCH` when the name matches more than one heading block, and `LINES_OUT_OF_RANGE` when
the range shares no line with the body; none of them SHALL be `NOT_FOUND`, which keeps meaning
that the note does not exist. A `HEADING_NOT_FOUND` item SHALL carry the body span as `lines` and
the note's full `outline`, collapsed by the same rule as outline mode; an `AMBIGUOUS_MATCH` item
SHALL carry `matches`, the candidate heading blocks as `{ heading, level, lines }`; a
`LINES_OUT_OF_RANGE` item SHALL carry the body span as `lines`. The `message` SHALL state the cause
and the retry. A miss SHALL have this shape under every `content` mode, and a `frontmatter`-mode
item SHALL still resolve its selector.

#### Scenario: an unknown heading returns the outline to retry with

- **WHEN** `read_notes` is called with `{ path: 'a.md', heading: 'Progres' }` for a note without
  that heading
- **THEN** the item carries `error.code: 'HEADING_NOT_FOUND'`, `lines` (the body span), and
  `outline`, and no `frontmatter`

#### Scenario: a cross-parent duplicate is ambiguous

- **WHEN** a note has `### Notes` under two different parents and `read_notes` is called with
  `heading: 'Notes'`
- **THEN** the item carries `error.code: 'AMBIGUOUS_MATCH'` and `matches` listing both heading
  blocks with their `lines`

#### Scenario: a range inside frontmatter is out of range

- **WHEN** `read_notes` is called with `{ path, lines: [1, 3] }` for a note whose frontmatter ends
  on line 4
- **THEN** the item carries `error.code: 'LINES_OUT_OF_RANGE'` and `lines` (the body span)

#### Scenario: a miss does not fail the other items

- **WHEN** a call reads `a.md` whole and `{ path: 'b.md', heading: 'Missing' }`
- **THEN** `a.md` is returned normally, the `b.md` item is a miss, and `errors` is 1

#### Scenario: a frontmatter-mode selector still misses

- **WHEN** `read_notes` is called with `content: 'frontmatter'` and
  `{ path: 'a.md', heading: 'Missing' }`
- **THEN** the item is a `HEADING_NOT_FOUND` miss, not a frontmatter result

### Requirement: A search hit reads back through its lines

`read_notes` SHALL return exactly a `search_notes` evidence row's text from the unchanged note when
that row's `lines` — a body block's or a lexical match's — is read as `{ path, lines }`. For a
semantic block whose `heading` is non-empty and not `---frontmatter---`, `{ path, heading }` SHALL
return the same text and the same `lines`. The frontmatter block (`heading: '---frontmatter---'`)
lies outside the body, so its `lines` are `LINES_OUT_OF_RANGE`. It SHALL be read with
`content: 'frontmatter'` on its path, and the description SHALL say so.

#### Scenario: every semantic block of a note round-trips

- **WHEN** a note with frontmatter, a preamble, a heading block, and own-paragraph sub-blocks is
  chunked, and each block's `lines` other than the frontmatter block's is read as
  `{ path, lines }`
- **THEN** each read returns exactly that block's text

#### Scenario: a frontmatter block hands off as a frontmatter read

- **WHEN** a semantic `---frontmatter---` block with `lines: [1, 4]` is read as
  `{ path, lines: [1, 4] }`
- **THEN** the item is a `LINES_OUT_OF_RANGE` miss, and `content: 'frontmatter'` on that path
  returns the note's frontmatter

#### Scenario: a heading block reads the same by name and by lines

- **WHEN** a semantic block with `heading: 'Decisions'` and `lines: [23, 27]` is read as
  `{ path, heading: 'Decisions' }`
- **THEN** the item returns the same text as `{ path, lines: [23, 27] }`, with `lines: [23, 27]`

#### Scenario: a lexical match round-trips past frontmatter

- **WHEN** a lexical body match in a note with frontmatter reports `lines`, and they are read as
  `{ path, lines }`
- **THEN** the item returns the matched unit's text

