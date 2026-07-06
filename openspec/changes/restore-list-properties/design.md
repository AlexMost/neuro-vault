# Design: restore-list-properties

## Context

v11.0.0 (commit 907b70d) removed three underused MCP tools. Two removals hold up: `read_property` is fully replaced by `read_notes` (`content: 'frontmatter'`), and `get_stats` was a deliberate surface surrender. The third — `list_properties` → `get_vault_overview` — turned out to be a lossy delegation: the overview caps properties at `TOP_PROPERTIES_LIMIT = 30` (`src/lib/obsidian/vault-overview.ts`), and a downstream vault-health pipeline needs the untruncated inventory for property-consistency audits (rare/one-off/misspelled keys are the signal, not noise).

Constraints and prior art:

- `provider.listProperties()` was deliberately kept in v11 (`get_vault_overview` depends on it) — the capability is alive, only the MCP wrapper is gone.
- The sibling tool `list_tags` has the exact shape this tool needs: optional `vault` param, multi-vault fan-out via `runFanOut`, `{ vault, results: [{name, count}] }` output.
- The existing `mcp-tool-surface` spec explicitly requires `list_properties` to be ABSENT — this change modifies that requirement (delta spec required).
- ADR-0005 (parameter dictionary): reusing the original tool name and the shared `vault` parameter keeps the dictionary intact; no new parameter concepts.

Stakeholders: downstream MCP consumers (vault-health pipeline is the driver), agents routing between orientation (`get_vault_overview`) and audit (`list_properties`).

## Goals / Non-Goals

**Goals:**

- Expose the complete frontmatter-property inventory (`[{name, count}]`, count-desc) via MCP again.
- Make the orientation-vs-audit split explicit in every description that mentions properties, so agents pick the right tool.
- Additive, non-breaking release (minor version).

**Non-Goals:**

- Restoring `read_property` or `get_stats` (replacements confirmed acceptable).
- Changing `get_vault_overview`'s payload shape or `TOP_PROPERTIES_LIMIT`.
- Adding property *types* to the output (the provider returns `{name, count}`; type inference stays an overview concern).

## Decisions

### D1: Restore the dedicated tool (vs flag on overview vs raising the cap)

- **Choice**: re-register `list_properties` as its own tool, near-verbatim revert of the v10 wrapper.
- **Rationale**: a fixed higher cap still silently truncates (the reported defect); a `full_properties` flag on `get_vault_overview` muddies a single-purpose orientation snapshot and complicates its fan-out payload. A dedicated tool is a stable, self-describing contract and is what the consumer's existing code already calls.
- **Alternatives considered**: raise `TOP_PROPERTIES_LIMIT` (rejected: any N loses the tail); overview flag (rejected: two output shapes for one tool, weaker discoverability).

### D2: Mirror `list_tags` exactly

- **Choice**: identical structure — `vaultParamShape`, `runFanOut` when `vault` omitted in multi-vault mode, `{ vault, results }` flat output otherwise.
- **Rationale**: the two tools are semantically siblings (vault-wide metadata inventories); symmetry keeps the parameter dictionary and fan-out contract uniform. Registration order places `list_properties` directly after `list_tags`.
- **Alternatives considered**: single-vault-only tool (rejected: v10 version already fanned out; regressing multi-vault would surprise consumers).

### D3: Encode the differentiator in descriptions, not just docs

- **Choice**: the tool description states "ALL … complete inventory, unlike `get_vault_overview` which truncates"; `get_vault_overview`'s description gains the mirror note; server instructions name the consistency-audit use case.
- **Rationale**: agents route by descriptions at call time; docs alone don't prevent the wrong-tool round trip.

### D4: No ADR

- **Choice**: no new `docs/adr/` entry.
- **Rationale**: no new dependency, no invariant change, and the decision (dedicated tool per ADR-0005 discipline) follows existing ADRs rather than amending them. The reversal of the v11 surface decision is captured in the `mcp-tool-surface` delta spec, which is that record's home.

## Risks / Trade-offs

- [Risk] Huge vaults could return a large property list → Mitigation: accepted; entries are `{name, count}` pairs and property-name cardinality is inherently small compared to note counts — orders of magnitude below `query_notes` payloads.
- [Trade-off] Tool count grows back to 11 operations tools after v11 trimmed it → accepted: the removal thesis ("another tool covers it") was wrong for this tool; keeping it removed preserves a defect, not a simplification.
- [Risk] Stale doc/spec references to the removal linger → Mitigation: verify gate includes the user-facing reference check; delta spec supersedes the absence requirement.

## Migration Plan

N/A — additive change, no deployment steps beyond the normal release flow (Conventional Commit `feat(tools): restore list_properties` → PR to `main` → `npm run release`, lands as 12.1.0). Rollback = revert the commit; no data or config migration.

## Open Questions

_None._
