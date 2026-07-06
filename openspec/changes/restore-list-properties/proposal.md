# Proposal: restore-list-properties

## Why

v11.0.0 removed the `list_properties` MCP tool, delegating property enumeration to `get_vault_overview`. That delegation is lossy: the overview truncates properties to the top 30 by count, silently dropping the rare, one-off, and misspelled keys. A downstream consumer's vault-health pipeline runs a property-consistency sweep that needs the FULL inventory — the truncated tail is exactly what it audits. The replacement covers orientation, not audit; the audit use case has no MCP-visible substitute, and it currently blocks the consumer's 10.1.0 → 12.x migration.

## What Changes

**`list_properties` tool availability**

- From: the server SHALL NOT expose `list_properties`; property enumeration is served by `get_vault_overview` (top 30 only, tail intentionally unavailable).
- To: the server SHALL expose `list_properties` returning the complete property inventory with counts; `get_vault_overview` keeps its top-30 truncation and points to `list_properties` for the full list.
- Reason: the v11 removal conflated orientation (top-N snapshot) with audit (complete inventory); the audit use case is real and unserved.
- Impact: non-breaking, additive (minor version). `read_property` and `get_stats` stay removed — their replacements are confirmed acceptable by the consumer.

**Documentation surface**

- Tool descriptions (`list_properties`, `get_vault_overview`), server instructions, README multi-vault section, and `docs/guide/reading-and-modifying.md` state the full-inventory vs top-N distinction so agents route correctly.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `mcp-tool-surface`: the requirement "Frontmatter property enumeration is served by get_vault_overview" (which mandates `list_properties` absence and declares the tail intentionally unavailable) is replaced by a requirement that `list_properties` IS registered, returns the untruncated inventory, and participates in multi-vault fan-out like `list_tags`.

## Impact

- **Code**: `src/modules/operations/tools/list-properties.ts` (restored), registration in `src/modules/operations/tools/index.ts`, `src/lib/tool-names.ts`, handler types in `src/modules/operations/types.ts`, description in `src/modules/operations/tools/get-vault-overview.ts`, instruction text in `src/server.ts`.
- **Provider**: none — `provider.listProperties()` never left (kept in v11 for `get_vault_overview`).
- **Tests**: registration counts 10 → 11 operations tools (13 → 14 combined), assertions flipped from absence to presence, new description test.
- **Docs**: README, `docs/guide/reading-and-modifying.md`.
- **Consumers**: unblocks the vault-health property-consistency sweep; no action needed from consumers who don't use the tool.
