## MODIFIED Requirements

### Requirement: Embed text is derived by two fixed formulas

Extraction SHALL derive the text sent to the embedding model by exactly two formulas. A block's embed text SHALL be its breadcrumbs — the block key with `/` replaced by ` > `, the final heading segment dropped, and a trailing `.md` removed — followed by a newline and the block's text. A note's embed text SHALL be its path breadcrumbs, then `:`, then a newline, then the note's full text. Extraction SHALL NOT cut either formula to a character budget: how much of an embed text reaches the model is decided by the active profile's tokenizer (see Requirement: Model input is bounded to the model's context window). Both formulas SHALL include path breadcrumbs, so embed text is a function of the note's path as well as its content.

#### Scenario: A block's own heading is not repeated in its breadcrumbs

- **WHEN** the block keyed `Folder/Note.md#Top#Inner` is prepared for embedding
- **THEN** its embed text begins `Folder > Note > Top` followed by a newline and the block's text, with `Inner` absent from the breadcrumbs

#### Scenario: A long note's embed text is not cut by characters

- **WHEN** a note's breadcrumbs plus full text are longer than 1894 characters
- **THEN** the note's embed text is the whole string, and any truncation happens in tokens when it is embedded

#### Scenario: Moving a note changes its embed text

- **WHEN** a note's content is unchanged but its path changes
- **THEN** both its note-level embed text and every block's embed text differ from those produced at the old path

---

### Requirement: Extraction rules are content rules, not membership rules

The size gate SHALL decide only what text of an included note is embedded, and SHALL NOT decide which notes are included; membership SHALL come from the vault scope alone. Truncation to the model's context window, which happens when text is embedded, SHALL likewise decide only how much of an embed text reaches the model. Extraction SHALL apply to Markdown notes only, and SHALL NOT implement per-heading exclusion.

#### Scenario: A gated note is still a member of the vault

- **WHEN** a note is too short to be embedded
- **THEN** it remains visible to every scope-governed surface, and its absence from the corpus is not an exclusion

---

### Requirement: Model input is bounded to the model's context window

The embedding provider SHALL bound every input to the active profile's maximum input length in tokens, as counted by that profile's own tokenizer, and SHALL NOT bound it by a character count derived from an assumed characters-per-token ratio. The bound SHALL NOT depend on the maximum length a tokenizer configuration declares, which can be effectively unbounded. Truncation SHALL preserve the profile's special-token template (see the `embedding-model-profiles` capability). An input longer than the window SHALL be truncated and embedded, never raise.

#### Scenario: An over-long input returns a vector instead of throwing

- **WHEN** text whose tokenization exceeds the profile's maximum input length is embedded
- **THEN** a vector of the profile's dimension is returned, and no runtime error is raised

#### Scenario: The bound is in tokens of the active profile

- **WHEN** the same long note is embedded under two profiles whose tokenizers split it into different numbers of tokens
- **THEN** each model receives at most its own profile's maximum number of tokens, and neither receives a prefix of the text chosen by a character count
