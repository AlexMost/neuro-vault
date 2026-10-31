## MODIFIED Requirements

### Requirement: A note is chunked into keyed blocks by its headings

Extraction SHALL determine block boundaries by parsing the note as CommonMark and SHALL split it into blocks at ATX headings of levels 1–6 that are direct children of the document root, identifying every block by a key formed from the note path followed by the hierarchical heading path (`<path>#<H1>#<H2>`), where the separator repetition encodes the child's real heading level so a skipped level is visible in the key. Frontmatter SHALL become a block keyed `#---frontmatter---`, text preceding the first heading SHALL become a block keyed `#`, content chunks under a heading SHALL take numbered keys `#{n}`, and a repeated top-level heading SHALL take a `[2]`-style suffix. A heading SHALL NOT start a block when it sits inside fenced or indented code or an HTML block, when it is nested inside a blockquote or a list item, when it is a setext heading rather than an ATX one, or when its title is empty. Each block SHALL carry a 1-based inclusive line span, and a heading block's span SHALL cover its whole section including nested subsections, so parent and child spans overlap. Line numbers SHALL count the note's real lines: a trailing newline SHALL terminate the last line rather than start a new one, so no span SHALL end past the note's last real line.

#### Scenario: Nested headings produce hierarchical keys

- **WHEN** a note contains `# Top` and, under it, `## Inner`
- **THEN** extraction yields a block keyed `#Top` whose span covers the whole section and a block keyed `#Top#Inner` whose span covers only the inner section

#### Scenario: Frontmatter and preamble get their own blocks

- **WHEN** a note opens with a YAML frontmatter fence followed by a paragraph and only then a heading
- **THEN** extraction yields a block keyed `#---frontmatter---` whose span includes the fence delimiters, and a block keyed `#` for the paragraph

#### Scenario: A heading inside a code fence does not split the note

- **WHEN** a fenced code block contains a line beginning with `#`
- **THEN** no block starts at that line, and the enclosing section's span is unbroken

#### Scenario: A heading nested inside a blockquote does not split the note

- **WHEN** a line beginning with `#` appears inside a blockquote rather than at the document root
- **THEN** no block starts at that line, and the enclosing section's span is unbroken

#### Scenario: A setext heading does not split the note

- **WHEN** a paragraph is followed directly by an underline of `=` or `-` characters, which CommonMark reads as a setext heading
- **THEN** no block starts at that paragraph, and it remains part of the enclosing section rather than becoming a heading block keyed on its full text

#### Scenario: A heading that runs on inside an HTML block does not split the note

- **WHEN** a `#` line appears inside an HTML block that has not yet been ended by a blank line
- **THEN** no block starts at that line, and the enclosing section's span continues until the HTML block ends

#### Scenario: A trailing newline adds no line

- **WHEN** a note's content is `# A\ntext\n` (two lines, ending in a newline)
- **THEN** the block keyed `#A` spans `[1, 2]`, not `[1, 3]`, and its text is `# A\ntext`

#### Scenario: A note without a trailing newline is unchanged

- **WHEN** a note's content is `# A\ntext` (no final newline)
- **THEN** the block keyed `#A` spans `[1, 2]`, exactly as for the same note ending in a newline
