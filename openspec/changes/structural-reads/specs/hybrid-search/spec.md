## MODIFIED Requirements

### Requirement: The search_notes description carries call-time guidance only

The `search_notes` tool description SHALL carry only what a caller needs before issuing a call — what the tool does, how to write the query, the axes, the everyday parameters, the pre-filter shape, and worked examples — and SHALL NOT carry prose whose only use is interpreting a response already in hand once that prose can travel on the response instead (`semantic_status.note`, `query_stats[].note`), per ADR-0010's response channel. Expert similarity floors (`threshold`, `expansion_floor`) SHALL be documented on the input schema, next to the field a caller fills, rather than in the description. The description SHALL NOT restate which fields are absent from a payload, SHALL NOT enumerate `matches[]` entry fields beyond `found_in`'s provenance meaning, and SHALL state any one fact once rather than under two headings. The single exception to the enumeration rule is exactly one RESPONSE SHAPE line that states the evidence coordinates (`lines` is `[start, end]`, file-relative with frontmatter counted, 1-based, inclusive) and the hand-off to `read_notes` (`{ path, lines }`, a `blocks[].heading` other than `""` or `---frontmatter---` as `{ path, heading }`, `lexical[].heading` a label): it is guidance for the next call, and the evidence itself stays unchanged. Its length SHALL NOT exceed 4,050 characters, measured on the longer multi-vault variant and asserted against the registered tool's advertised description so the budget fails CI rather than review.

#### Scenario: the description stays inside its budget

- **WHEN** the `search_notes` tool is registered against a multi-vault registry and its advertised `description` is measured
- **THEN** it is at most 4,050 characters

#### Scenario: the description carries the read_notes hand-off in one line

- **WHEN** the description's RESPONSE SHAPE section is read
- **THEN** exactly one line states that evidence `lines` are file-relative, 1-based and inclusive, and that a hit reads back with `read_notes({ paths: [{ path, lines }] })`

#### Scenario: expert knobs stay callable while leaving the description

- **WHEN** the registered tool is inspected for `threshold` and `expansion_floor`
- **THEN** both are advertised and validated by `inputSchema`, each carrying its own description there, and neither is documented in the tool description

#### Scenario: semantic_status costs one line, not a section

- **WHEN** the description is read for `semantic_status`
- **THEN** it names the field and its four state values without explaining what each state does to a response, because the response's own `note` carries that

#### Scenario: invariants are not addressed to the caller

- **WHEN** the description is read
- **THEN** it contains no section stating which evidence fields are absent for a given `found_in` value, since a caller reads the fields the payload contains

#### Scenario: query-writing guidance is preserved

- **WHEN** the description is read
- **THEN** it still instructs the caller to build the query from the core nouns, to pass synonyms and translations as one array in a single call, and it still carries the worked examples
