## ADDED Requirements

### Requirement: Stringified collections are parsed when unambiguous

The boundary SHALL parse a JSON-string into the object or array a parameter expects
when the string is of the correct shape, and accept the parsed value. For an array
parameter, element types SHALL still be validated after parsing, so an invalid element
is rejected rather than silently accepted.

#### Scenario: Stringified array for a plain-array parameter is parsed

- **WHEN** `get_similar_notes` is called with `{ path: 'Note.md', exclude_folders: '["Templates"]' }`
- **THEN** `exclude_folders` SHALL be parsed to `['Templates']` and the call SHALL proceed

#### Scenario: Stringified object for an object parameter is parsed

- **WHEN** `query_notes` is called with `filter` set to the string `'{"frontmatter.type":{"$eq":"idea"}}'`
- **THEN** `filter` SHALL be parsed to the equivalent object and the call SHALL succeed

#### Scenario: A bad element in a parsed array is still rejected

- **WHEN** a parameter whose array elements are constrained (e.g. an enum) receives a stringified array containing an element that violates the element schema
- **THEN** the call SHALL fail with a `INVALID_PARAMS` error identifying the invalid element, not silently accept it (parsing the outer string does not bypass element validation)

### Requirement: Unrecoverable arguments fail with a shape-naming message

When a supplied value cannot be coerced to the expected shape, the tool SHALL fail
with the existing fatal `INVALID_PARAMS` code and a message that names the expected
shape (for example "expected array or JSON-string of one, got …"), rather than a bare
validation message.

#### Scenario: Non-JSON string for an array parameter names the expected shape

- **WHEN** `get_similar_notes` is called with `{ path: 'Note.md', exclude_folders: 'Templates' }` (a non-JSON, non-array string)
- **THEN** the call SHALL fail with `INVALID_PARAMS` and a message naming the expected array shape

#### Scenario: JSON string that resolves to a non-array names the expected shape

- **WHEN** an array parameter receives a JSON-string that parses to a non-array (e.g. `'{"a":1}'`)
- **THEN** the call SHALL fail with `INVALID_PARAMS` and a message naming the expected array shape

### Requirement: Unknown keys remain rejected

The input boundary SHALL keep rejecting keys that are not a parameter of the tool.
Tolerance applies only to coercible value shapes; it MUST NOT silently ignore
unrecognized parameters.

#### Scenario: A genuinely unknown key still errors

- **WHEN** a tool is called with a key that is not one of its parameters
- **THEN** the call SHALL fail as an unrecognized-key validation error
