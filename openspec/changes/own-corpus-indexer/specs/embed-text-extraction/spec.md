# embed-text-extraction Delta

## ADDED Requirements

### Requirement: A note is chunked into keyed blocks by its headings

Extraction SHALL split a Markdown note into blocks at ATX headings of levels 1–6 and SHALL identify every block by a key formed from the note path followed by the hierarchical heading path (`<path>#<H1>#<H2>`), where the separator repetition encodes the child's real heading level so a skipped level is visible in the key. Frontmatter SHALL become a block keyed `#---frontmatter---`, text preceding the first heading SHALL become a block keyed `#`, content chunks under a heading SHALL take numbered keys `#{n}`, a repeated top-level heading SHALL take a `[2]`-style suffix, and headings inside fenced code blocks SHALL NOT start a block. Each block SHALL carry a 1-based inclusive line span, and a heading block's span SHALL cover its whole section including nested subsections, so parent and child spans overlap.

#### Scenario: Nested headings produce hierarchical keys

- **WHEN** a note contains `# Top` and, under it, `## Inner`
- **THEN** extraction yields a block keyed `#Top` whose span covers the whole section and a block keyed `#Top#Inner` whose span covers only the inner section

#### Scenario: Frontmatter and preamble get their own blocks

- **WHEN** a note opens with a YAML frontmatter fence followed by a paragraph and only then a heading
- **THEN** extraction yields a block keyed `#---frontmatter---` whose span includes the fence delimiters, and a block keyed `#` for the paragraph

#### Scenario: A heading inside a code fence does not split the note

- **WHEN** a fenced code block contains a line beginning with `#`
- **THEN** no block starts at that line, and the enclosing section's span is unbroken

### Requirement: Block keys are unique within a note

Extraction SHALL produce a distinct key for every block of a note, disambiguating a heading repeated among its siblings at any level with an occurrence suffix. No two blocks of one note SHALL share a key, since a block key is the block's identity in the corpus and a collision would silently drop a block.

#### Scenario: Repeated sibling sub-headings get distinct keys

- **WHEN** a note contains two sections whose heading text is identical and whose parent heading is the same
- **THEN** the two blocks receive different keys, and both are present in the extraction output

### Requirement: Embed text is derived by two fixed formulas

Extraction SHALL derive the text sent to the embedding model by exactly two formulas. A block's embed text SHALL be its breadcrumbs — the block key with `/` replaced by ` > `, the final heading segment dropped, and a trailing `.md` removed — followed by a newline and the block's text. A note's embed text SHALL be its path breadcrumbs, then `:`, then a newline, then the note's full text, truncated to `max_tokens × 3.7` characters for the configured model (1894 characters for the 512-token default). Both formulas SHALL include path breadcrumbs, so embed text is a function of the note's path as well as its content.

#### Scenario: A block's own heading is not repeated in its breadcrumbs

- **WHEN** the block keyed `Folder/Note.md#Top#Inner` is prepared for embedding
- **THEN** its embed text begins `Folder > Note > Top` followed by a newline and the block's text, with `Inner` absent from the breadcrumbs

#### Scenario: A long note's embed text is truncated by characters

- **WHEN** a note's breadcrumbs plus full text exceed the character budget for the configured model
- **THEN** the embed text is the first `max_tokens × 3.7` characters of that string, cut without regard to word or line boundaries

#### Scenario: Moving a note changes its embed text

- **WHEN** a note's content is unchanged but its path changes
- **THEN** both its note-level embed text and every block's embed text differ from those produced at the old path

### Requirement: A size gate decides what is embedded

Extraction SHALL mark a note or block for embedding only when its size reaches the configured minimum of 200 characters, and SHALL additionally skip a block that is entirely covered by sub-blocks which are themselves marked for embedding. A note below the gate SHALL still be extracted and MAY yield blocks; it simply has no note-level embed text.

#### Scenario: A short note yields no note-level embed text

- **WHEN** a note's text is shorter than the minimum
- **THEN** extraction marks no note-level embed input for it, while any block of its own that reaches the minimum is still marked

#### Scenario: A fully covered parent block is skipped

- **WHEN** a heading block's span is entirely covered by sub-blocks that are themselves marked for embedding
- **THEN** the parent block is not marked, while a parent that also holds text of its own outside those sub-blocks remains marked

### Requirement: Extraction rules are content rules, not membership rules

The size gate and the truncation SHALL decide only what text of an included note is embedded, and SHALL NOT decide which notes are included; membership SHALL come from the vault scope alone. Extraction SHALL apply to Markdown notes only, and SHALL NOT implement per-heading exclusion.

#### Scenario: A gated note is still a member of the vault

- **WHEN** a note is too short to be embedded
- **THEN** it remains visible to every scope-governed surface, and its absence from the corpus is not an exclusion

### Requirement: Extraction is deterministic

Extraction SHALL be a pure function of the note's path, its content, and the extraction strategy identifier: the same three inputs SHALL always yield the same blocks, keys, spans and embed texts, with no dependence on wall-clock time, iteration order, or previously extracted state.

#### Scenario: Repeated extraction is identical

- **WHEN** the same note content at the same path is extracted twice
- **THEN** both runs produce byte-identical block keys, spans and embed texts

### Requirement: Model input is bounded to the model's context window

The embedding service SHALL bound its tokenized input to the model's real maximum sequence length rather than relying on the model's shipped tokenizer configuration, which declares an effectively unbounded length and thereby disables the pipeline's own truncation. An input longer than that window SHALL be truncated and embedded, never raise.

#### Scenario: An over-long input returns a vector instead of throwing

- **WHEN** text whose tokenization exceeds the model's maximum sequence length is embedded
- **THEN** a vector of the model's dimension is returned, and no runtime error is raised
