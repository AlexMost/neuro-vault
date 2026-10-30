## RENAMED Requirements

- FROM: `### Requirement: Matching is normalized substring AND`
- TO: `### Requirement: Matching is normalized word-prefix AND`

## MODIFIED Requirements

### Requirement: Matching is normalized word-prefix AND

Matching SHALL be case- and accent-insensitive word-prefix comparison over normalized text: lowercase → NFKD → strip combining marks → apostrophe unification (`'`, `ʼ`, `’`, `‘` fold to one form) → whitespace collapse. A token SHALL match a unit only at an occurrence that starts at a word boundary — the start of the unit, or a position whose preceding character is not a word character, where a word character is a letter, a digit, `_` or the unified apostrophe — and the token's end SHALL be free, so a token matches the start of a longer word. A token whose first character is neither a letter nor a digit SHALL match at any occurrence. A multi-token query SHALL match a unit only if every token matches it (AND); the whole normalized query matching as one contiguous string under the same boundary rule SHALL rank as a phrase match. Queries SHALL be tokenized on whitespace with punctuation retained inside tokens. The per-token counts of `lexical_tokens` SHALL apply the same rule.

#### Scenario: case and Cyrillic folding

- **WHEN** a note is titled `Пошук` and the query is `ПОШУК`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:title"`

#### Scenario: apostrophe variants unify

- **WHEN** a note contains `об’єкт` (U+2019) and the query is `об'єкт` (U+0027)
- **THEN** the note appears in `matches[]` with lexical provenance

#### Scenario: inflected forms match by word prefix

- **WHEN** a note heading contains `пошуком` and the query is `пошук`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:heading"`

#### Scenario: a token inside a longer word does not match

- **WHEN** a note's only text containing `api` is the word `rapid`, and the query is `api` in `mode: "lexical"`
- **THEN** the note does not appear in `matches[]`

#### Scenario: an occurrence after punctuation starts a word

- **WHEN** a note body contains `tolerant-arguments` and the query is `tolerant arguments` in `mode: "lexical"`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:body"`

#### Scenario: underscore and apostrophe are inside a word

- **WHEN** a note's only text containing `arguments` is `tolerant_arguments`, or its only text containing `єкт` is `об'єкт`, and the query is that token in `mode: "lexical"`
- **THEN** the note does not appear in `matches[]`

#### Scenario: a token led by punctuation needs no boundary

- **WHEN** a note body contains `GET v2/api/notes` and the query is `/api` in `mode: "lexical"`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:body"`

### Requirement: Lexical leg matches title, headings, and body blocks

The lexical leg SHALL match against the note title (filename without `.md`), markdown headings, and body content, where body units are block-level markdown AST nodes with line positions. A multiword phrase split across hard-wrapped source lines within one paragraph SHALL still match as a phrase. Text inside fenced code blocks SHALL NOT be treated as headings. Frontmatter SHALL be excluded from body matching. A fenced code block whose language is `compressed-json` (an Excalidraw drawing payload) SHALL NOT be a unit: it SHALL NOT match, count toward `query_stats`, or appear in `lexical[]`, while the rest of the note, including the drawing's `Text Elements` section, SHALL still match.

#### Scenario: phrase matches across a hard-wrapped line break

- **WHEN** a note body contains `векторний\nпошук` inside one paragraph and the query is `векторний пошук`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:body"` and a `lexical[]` entry at that paragraph's line range

#### Scenario: heading inside a code fence is not a heading match

- **WHEN** a note's fenced code block contains the line `# пошук` and the query is `пошук`
- **THEN** any match for that block is reported with `matched_in: "body"`, not `matched_in: "heading"`

#### Scenario: a drawing payload does not match

- **WHEN** a drawing note's only occurrence of the query token is inside its `compressed-json` code block, in `mode: "lexical"`
- **THEN** the note does not appear in `matches[]`, and the query's `lexical` count in `query_stats` does not include it

#### Scenario: a drawing's text elements still match

- **WHEN** a drawing note's `Text Elements` section contains the query token, in `mode: "lexical"`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:body"`
