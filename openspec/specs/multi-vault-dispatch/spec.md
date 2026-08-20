# multi-vault-dispatch Specification

## Purpose
TBD - created by archiving change multi-vault-dispatch-builder. Update Purpose after archive.
## Requirements
### Requirement: One builder owns the multi-vault dispatch contract

Every fan-out-capable tool SHALL be constructed through a single shared builder that owns the `vault` parameter contribution, the dispatch branch, and the fan-out description suffix. A tool SHALL NOT re-implement the branch between fan-out and single-vault resolution in its own handler.

#### Scenario: no fan-out tool carries its own dispatch branch

- **WHEN** the source of a tool that supports fan-out is inspected
- **THEN** it contains no `registry.isMulti()` branch selecting between `runFanOut` and `resolveVault`, and instead supplies a per-vault function to the shared builder

#### Scenario: a new fan-out tool costs one per-vault function

- **WHEN** a sixth fan-out-capable tool is added
- **THEN** it is registered by supplying a per-vault function, its domain description, and its single-vault shape to the builder, adding no new copy of the dispatch branch, the fan-out prose, or the fan-out generic constraint

### Requirement: Dispatch resolves vault identically for every fan-out tool

A fan-out-capable tool SHALL fan out across all registered vaults when the registry holds more than one vault and `vault` is omitted; SHALL resolve to the single named vault when `vault` is supplied; and SHALL resolve to the only registered vault when the registry holds exactly one, whether or not `vault` was supplied.

#### Scenario: omitted vault in multi-vault mode fans out

- **WHEN** a fan-out tool is called without `vault` and the registry holds more than one vault
- **THEN** the response is the fan-out envelope `{ results_by_vault, skipped_vaults, failed_vaults }`

#### Scenario: an explicit vault targets one vault

- **WHEN** a fan-out tool is called with `vault: "<name>"` and the registry holds more than one vault
- **THEN** the response is that tool's single-vault shape for the named vault, and no fan-out envelope is returned

#### Scenario: an unknown vault name fails the whole call

- **WHEN** a fan-out tool is called with a `vault` name that is not registered
- **THEN** the call fails with a single fatal error rather than a per-vault entry in `failed_vaults`

#### Scenario: single-vault mode never fans out

- **WHEN** a fan-out tool is called and the registry holds exactly one vault
- **THEN** the response is that tool's single-vault shape and the `vault` parameter is absent from the advertised input schema

### Requirement: Each tool declares its single-vault return shape explicitly

The builder SHALL require every tool to state which single-vault return shape it follows, rather than applying a default. A tool whose payload has no vault identity of its own SHALL return the payload prefixed with `vault`; a tool whose result items each carry their own `vault` SHALL return the payload unchanged.

#### Scenario: a payload without vault identity is prefixed

- **WHEN** `list_tags`, `list_properties`, or `get_vault_overview` is called against a single vault
- **THEN** the response is `{ vault: "<name>", ...payload }`

#### Scenario: a payload whose items carry vault is returned unchanged

- **WHEN** `query_notes` or `search_notes` is called against a single vault
- **THEN** the response is the payload itself, with no added top-level `vault` key, and each result item carries its own `vault`

### Requirement: The fan-out contract text is identical across every fan-out tool

Every fan-out-capable tool's description SHALL carry the same fan-out contract text, sourced from one shared constant, so the wording cannot drift between tools. A tool MAY append its own domain-specific sentence after that text, and MAY state the `vault` parameter separately in its own parameter listing.

#### Scenario: all fan-out tools share byte-identical contract text

- **WHEN** the descriptions of every registered fan-out tool are compared in multi-vault mode
- **THEN** each contains the same shared fan-out contract substring, byte for byte

#### Scenario: the registered vault names are stated once per description

- **WHEN** a fan-out tool's description is read in multi-vault mode
- **THEN** it names the registered vaults exactly once, emitted by the shared helper rather than hand-composed by the tool

#### Scenario: single-vault mode omits the fan-out text entirely

- **WHEN** a fan-out tool's description is read and the registry holds exactly one vault
- **THEN** it contains no fan-out contract text and no vault-name listing

### Requirement: Tool descriptions do not advertise skipped_vaults

No tool description SHALL describe `skipped_vaults` while no code path can populate it. The field SHALL remain present in the fan-out response envelope for contract stability, so removing it from the description text MUST NOT change the response shape.

#### Scenario: no description mentions the field

- **WHEN** the description of every registered tool is inspected
- **THEN** none mentions `skipped_vaults`

#### Scenario: the response still carries the field

- **WHEN** a fan-out tool fans out across all registered vaults
- **THEN** the response still contains `skipped_vaults` as an empty array alongside `results_by_vault` and `failed_vaults`

