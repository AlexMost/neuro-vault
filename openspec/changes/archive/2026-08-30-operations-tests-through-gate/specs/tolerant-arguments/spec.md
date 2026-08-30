## ADDED Requirements

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
