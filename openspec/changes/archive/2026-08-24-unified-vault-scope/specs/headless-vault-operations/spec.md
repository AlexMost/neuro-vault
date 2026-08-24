# headless-vault-operations Delta

## MODIFIED Requirements

### Requirement: Tag and property listings aggregate from the vault scan

`listTags` and `listProperties` SHALL return `{ name, count }` entries aggregated from the same scoped disk scan that powers `query_notes` — notes excluded by the vault's scope (see the `vault-scope` capability) contribute to neither listing; property counting SHALL include frontmatter keys only, and tag counting SHALL include the per-note union of frontmatter `tags:` values and inline body `#tags`, counting each distinct tag at most once per note. Inline tags SHALL follow the Obsidian-documented grammar — `#` preceded by start-of-text or whitespace, tag characters `[A-Za-z0-9_/-]`, at least one non-numeric character, nested tags counted verbatim — and SHALL NOT be extracted from code fences, inline code, URL fragments, or markdown heading markers. The `tags` filter of `query_notes` and `search_notes` remains frontmatter-only; `list_tags` MAY therefore report tags that a `tags` filter cannot match, and both tool descriptions SHALL state this asymmetry.

#### Scenario: Frontmatter tags are counted

- **WHEN** three notes carry `alpha` in their frontmatter `tags:` field
- **THEN** `list_tags` reports `{ name: "alpha", count: 3 }`

#### Scenario: Inline body tags are counted

- **WHEN** a note contains `#beta` in its body but not in frontmatter `tags:`
- **THEN** `beta` contributes 1 to `list_tags` counts, and `get_vault_overview.top_tags` reflects it

#### Scenario: A tag is counted once per note

- **WHEN** a note carries `gamma` in frontmatter `tags:` and also writes `#gamma` (twice) in its body
- **THEN** `list_tags` reports `{ name: "gamma", count: 1 }` for that note's contribution

#### Scenario: Duplicated frontmatter entries count once

- **WHEN** a note's frontmatter is `tags: [alpha, alpha]`
- **THEN** that note contributes 1 to `alpha`'s count

#### Scenario: Non-tag `#` sequences are excluded

- **WHEN** a note body contains `#123`, a fenced code block with `#fenced`, inline code `` `#inline` ``, a URL `https://example.com/#section`, and a heading line `## Heading`
- **THEN** none of `123`, `fenced`, `inline`, `section`, or `Heading` appear in `list_tags`

#### Scenario: Nested inline tags count verbatim

- **WHEN** a note body contains `#project/alpha`
- **THEN** `list_tags` reports `project/alpha` (no split into `project`)

#### Scenario: Inline-only tags are not filterable

- **WHEN** a tag exists only inline in note bodies
- **THEN** `list_tags` reports it while `query_notes` with `filter: { tags: <tag> }` matches no notes, and the `list_tags` and `query_notes` descriptions state this asymmetry

#### Scenario: Property names are counted across notes

- **WHEN** a frontmatter key `status` appears in five notes
- **THEN** `list_properties` reports `{ name: "status", count: 5 }`

#### Scenario: An out-of-scope note contributes no tags or properties

- **WHEN** a note under a scope-excluded folder (e.g. `Templates/`) carries frontmatter `tags: [delta]` and a `status` property
- **THEN** `delta` does not appear in `list_tags` and that note contributes nothing to `list_properties`
