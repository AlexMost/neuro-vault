## Why

`.neuro-vault/for-external-agents.md` is how a vault owner tells an external agent how *this* vault is organised — the one thing tool descriptions can never say. It currently reaches nobody. Claude Code truncates MCP `instructions` at exactly 2048 characters, and the vault block is appended last, behind a 10,803-character static preamble: it is cut before ~11k and is dead at any file size. Sub-agents get no `instructions` at all. So the feature ships, is documented, and delivers zero. Both defects are client behavior we cannot fix, so the fix is to stop depending on that channel: repair its ordering cheaply, and add a second channel with no cap that also reaches sub-agents.

## What Changes

**Instructions composition order**
- From: static preamble → overview hint → multi-vault section → per-vault conventions blocks (last).
- To: per-vault conventions blocks (first) → condensed preamble.
- Reason: the vault block is the only content the client cannot obtain from tool descriptions, so it must be the part that survives truncation.
- Impact: non-breaking; `instructions` is advisory text, no tool contract moves.

**Static preamble size**
- From: 10,803 characters, 15 headings, largely restating tool descriptions (`query_notes` operators and result shape, the multi-vault fan-out rules already appended to 12 descriptions by `describeMultiVault`).
- To: ~600–800 characters carrying only what no tool description says — the "second brain" role, operations-vs-semantic routing, and project-scope discovery order.
- Reason: a typical ~1200-character vault block plus a small preamble must fit inside 2048.
- Impact: non-breaking. Content is deleted only where a tool description already carries it; anything else moves into the relevant description instead.

**`get_vault_overview` response**
- From: `{ total_notes, folders, top_tags, properties, top_by_backlinks }`.
- To: the same plus optional `conventions` (raw `for-external-agents.md` contents, read at call time) and `conventions_truncated` when a soft size cap trims it. Field absent entirely when the file is missing or empty. In multi-vault fan-out, each `results_by_vault` entry carries its own. The `vault://overview` resource inherits both fields from the shared compute.
- Reason: tool descriptions and tool responses are the only channels that arrive intact everywhere, including sub-agents; reading at call time also means edited conventions are picked up without an MCP restart.
- Impact: additive, non-breaking. One sentence added to the tool description so agents know the field is authoritative.

## Capabilities

### New Capabilities

- `vault-conventions-delivery`: how a vault's `for-external-agents.md` reaches an agent — the ordering and size budget of composed MCP `instructions`, and the `conventions` field on `get_vault_overview` (both surfaces, single- and multi-vault, freshness, and truncation behavior).

### Modified Capabilities

<!-- None. No existing spec's requirements change: mcp-tool-surface pins which tool serves which need, not the overview payload's field set. -->

## Impact

- `src/server.ts` — `STATIC_SERVER_INSTRUCTIONS` rewritten; `buildServerInstructions` reordered; multi-vault section removed.
- `src/lib/obsidian/vault-overview.ts` — `VaultOverview` gains the two fields; `computeVaultOverview` gains the vault-path dependency needed to read the file.
- `src/modules/operations/tools/get-vault-overview.ts` — description sentence; fan-out and single-vault paths carry the field through.
- `src/modules/operations/resources/vault-overview.ts` — inherits, no logic change expected.
- `readExternalAgentInstructions` (`src/server.ts:31`) — moves to a shared location so both the startup path and the per-call path use one reader.
- Tests: `test/server-instructions.test.ts` (ordering + the 2048 budget assertion), vault-overview tests (field present / absent / truncated / per-vault / re-read).
- Docs: whole-`docs/` sweep including the model-facing guide layer — the feature's promise changes from "injected into instructions" to "every agent that calls the overview sees them"; `docs/architecture/mcp-server-shape.md` §instructions layering is now wrong.
- No dependency changes. No breaking contract change.
