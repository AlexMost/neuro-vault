# tolerant-arguments Specification

## Purpose

How the MCP tool-input boundary tolerates near-miss arguments instead of dead-ending: a stringified JSON collection is parsed when its shape is unambiguous, and a value that cannot be recovered fails with a message that names the expected shape — while genuinely unknown keys are still rejected. Keeps an agent that passes a JSON string where an object/array is expected from silently failing without a pivot.

## Requirements

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

### Requirement: The tolerant boundary applies uniformly to every registered tool

Every tool reachable by an MCP client SHALL have its declared input schema wrapped by the
same coercing, unknown-key-rejecting boundary at registration, and MUST NOT rely on any
per-tool exemption. A schema violation — wrong type, out-of-enum value, out-of-range bound,
or unrecognized key — SHALL therefore fail with `INVALID_PARAMS` before the tool's handler
runs. A tool MUST NOT re-implement, post-gate, a check its schema already expresses; the
`INVALID_ARGUMENT` code remains reserved for semantic argument faults a schema cannot
express (for example "exactly one of `name` or `path`", or a path that escapes the vault).

#### Scenario: an out-of-enum value fails at the boundary

- **WHEN** any tool is called with a value outside a declared enum parameter
- **THEN** the call SHALL fail with `INVALID_PARAMS` naming the field and the allowed values,
  and the tool's handler SHALL NOT run

#### Scenario: an out-of-range bound fails at the boundary

- **WHEN** any tool is called with an array or string argument that violates a declared
  minimum or maximum
- **THEN** the call SHALL fail with `INVALID_PARAMS` identifying the field, not with a
  handler-raised `INVALID_ARGUMENT`

### Requirement: A `vault` argument is an unknown key in single-vault mode

When exactly one vault is registered, tools SHALL NOT declare a `vault` parameter, and a
`vault` key supplied by a caller SHALL therefore be rejected as an unrecognized key with
`INVALID_PARAMS`. When two or more vaults are registered, `vault` SHALL be a declared
optional parameter on every tool that accepts one.

#### Scenario: `vault` supplied against a single-vault server

- **WHEN** a tool is called with `vault: "<name>"` on a server that has exactly one vault
  registered
- **THEN** the call SHALL fail with `INVALID_PARAMS` reporting `vault` as an unrecognized key

#### Scenario: `vault` accepted against a multi-vault server

- **WHEN** the same tool is called with `vault: "<name>"` on a server with two or more vaults
  registered
- **THEN** the argument SHALL be accepted and the call SHALL target the named vault
