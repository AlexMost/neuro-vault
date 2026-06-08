## ADDED Requirements

### Requirement: read_notes selects body granularity via a `content` mode

`read_notes` SHALL accept an optional `content` parameter with exactly the values
`'full'`, `'preview'`, or `'frontmatter'`. When `content` is omitted, the effective mode
SHALL be derived from the number of **distinct** requested paths (after de-duplication):
exactly one distinct path SHALL default to `'full'`, and two or more distinct paths SHALL
default to `'preview'`. An explicitly supplied `content` value SHALL always take precedence
over this count-based default. `read_notes` SHALL NOT expose a `fields` parameter. `paths`
semantics (string-or-array, 1–50, dedup, per-item errors) are otherwise unchanged.

#### Scenario: a single path defaults to the full body

- **WHEN** `read_notes` is called with exactly one distinct path and no `content` parameter
- **THEN** the successful item returns `{ path, frontmatter, content }` with the complete body
  and no `truncated` field

#### Scenario: multiple paths default to preview

- **WHEN** `read_notes` is called with two or more distinct paths and no `content` parameter
- **THEN** each successful item returns frontmatter plus a preview body and a `truncated` flag
  (full body only where the body is within the preview bound)

#### Scenario: duplicate of a single path still counts as one

- **WHEN** `read_notes` is called with the same path repeated and no `content` parameter
- **THEN** the request is treated as one distinct path and defaults to `'full'`

#### Scenario: explicit `content` overrides the count-based default

- **WHEN** `read_notes` is called with `content: 'full'` and two or more paths, **OR** with
  `content: 'preview'` and a single path
- **THEN** the explicit mode is applied to every item regardless of the path count

#### Scenario: `content: 'frontmatter'` returns frontmatter only

- **WHEN** `read_notes` is called with `content: 'frontmatter'`
- **THEN** each successful item returns `{ path, frontmatter }` with no `content` field and no
  `truncated` field

#### Scenario: an invalid `content` value is rejected

- **WHEN** `read_notes` is called with a `content` value other than `'full'`, `'preview'`, or
  `'frontmatter'` (e.g. `'none'`)
- **THEN** the call fails with an `INVALID_ARGUMENT` error

#### Scenario: a legacy `fields` parameter has no effect

- **WHEN** `read_notes` is called with a `fields` key (the removed parameter)
- **THEN** the key is ignored and the body is returned according to the count-based default

### Requirement: Frontmatter is always returned regardless of mode

`read_notes` SHALL include each successful item's parsed `frontmatter` in `'full'`, `'preview'`,
and `'frontmatter'` modes. There SHALL be no mode that returns a body without frontmatter.

#### Scenario: frontmatter present in every mode

- **WHEN** `read_notes` is called for a note that has frontmatter, in each of `'full'`, `'preview'`,
  and `'frontmatter'`
- **THEN** every successful item includes the `frontmatter` object

### Requirement: `preview` returns a bounded, boundary-cut body slice with a truncation signal

In `'preview'` mode, `read_notes` SHALL return frontmatter plus a deterministic, length-bounded
slice of the body, and SHALL mark whether the body was cut via a boolean `truncated` field on each
successful item. When the body is at or under the preview bound, the full body SHALL be returned
unchanged with `truncated: false`. When the body exceeds the bound, the returned `content` SHALL be
the body truncated at a word/line boundary at or before the bound, with a truncation marker
appended, and `truncated: true`.

#### Scenario: short body is returned intact

- **WHEN** `read_notes` resolves a note to `'preview'` mode and the note's body is at or under the
  preview bound
- **THEN** the item returns the complete body unchanged with `truncated: false`

#### Scenario: long body is truncated and flagged

- **WHEN** `read_notes` resolves a note to `'preview'` mode and the note's body exceeds the
  preview bound
- **THEN** the item returns a body slice no longer than the bound (plus marker), cut on a
  word/line boundary, ending in the truncation marker, with `truncated: true`

#### Scenario: truncation is deterministic

- **WHEN** `read_notes` resolves the same unchanged note to `'preview'` mode twice
- **THEN** the returned `content` and `truncated` values are identical across both calls
