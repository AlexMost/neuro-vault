## RENAMED Requirements

- FROM: `### Requirement: Frontmatter property enumeration is served by get_vault_overview`
- TO: `### Requirement: Full frontmatter property enumeration is served by list_properties`

## MODIFIED Requirements

### Requirement: Full frontmatter property enumeration is served by list_properties

The server SHALL expose a `list_properties` tool that returns the complete, untruncated inventory
of frontmatter properties in use across the vault as `{ name, count }` entries sorted by count
descending. `list_properties` SHALL appear in the canonical tool-name list (`TOOL_NAMES`) and in
the operations module's registered tools, positioned directly after its sibling `list_tags`. In
multi-vault mode the tool SHALL fan out across all registered vaults when `vault` is omitted
(response shape `results_by_vault`), and SHALL accept `vault: "<name>"` to target one vault,
mirroring `list_tags` exactly.

`get_vault_overview` SHALL keep returning the property list capped at the top 30 by count as part
of its orientation snapshot; the two tools split by use case — orientation (top-N snapshot) versus
audit (complete inventory). The tool descriptions of both `list_properties` and
`get_vault_overview` SHALL state this distinction so callers route correctly: `list_properties`
names the complete inventory and the property-consistency audit use case; `get_vault_overview`
marks its property list as top entries only and points at `list_properties` for the full inventory.

#### Scenario: list_properties is registered

- **WHEN** the server's registered tool names are enumerated
- **THEN** `list_properties` is present in the operations module and in `TOOL_NAMES`

#### Scenario: the full inventory is returned without truncation

- **WHEN** `list_properties` is called on a vault whose provider reports more than 30 distinct property names
- **THEN** the response contains every reported property as `{ name, count }`, sorted by count descending, with no cap applied

#### Scenario: multi-vault fan-out mirrors list_tags

- **WHEN** `list_properties` is called without `vault` while multiple vaults are registered
- **THEN** the response fans out with `results_by_vault` entries, exactly like `list_tags`

#### Scenario: get_vault_overview keeps the top-30 snapshot and points to list_properties

- **WHEN** `get_vault_overview` is called
- **THEN** its `properties` array remains capped at the top 30 by count, and its tool description directs callers to `list_properties` for the full inventory
