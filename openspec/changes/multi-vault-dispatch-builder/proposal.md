## Why

Five tools — `list_tags`, `list_properties`, `query_notes`, `get_vault_overview`,
`search_notes` — each hand-maintain the same glue around `runFanOut`: an
identical dispatch branch, the fan-out prose, and an `& Record<string, unknown>`
type contortion. The prose has already drifted into three variants, two of which
advertise `skipped_vaults` semantics `runFanOut` cannot deliver — it hard-codes
`[]`. Under ADR-0010 a tool description is a delivery channel, so that drift is a
behaviour bug reaching every agent, not cosmetic debt. Giving the contract one
owner fixes it at all five sites at once and makes recurrence testable rather
than review-dependent.

## What Changes

**Multi-vault dispatch branch**

- From: each of the five tools carries its own
  `if (input.vault === undefined && registry.isMulti()) → runFanOut(...)` /
  `resolveVault(...)` branch.
- To: a `buildMultiVaultTool` builder (`src/lib/multi-vault-tool.ts`) owns the
  branch; each tool supplies `runForEntry`, its domain prose, and which
  single-vault shape it follows (`withVaultName` or `payloadOnly`).
- Reason: the branch is the contract, and a contract copied five times has no
  owner.
- Impact: non-breaking — same dispatch semantics, same response shapes.

**Fan-out prose in tool descriptions**

- From: three drifted variants. `query_notes` and `get_vault_overview` describe
  `skipped_vaults: [...]` (pre-filtered out); `list_tags` and `list_properties`
  omit it; `search_notes` uses its own wording plus a hand-rolled copy of the
  `Registered vaults: ...` listing `describeMultiVault` already emits.
- To: one `FAN_OUT_SUFFIX` constant in `src/lib/vault-param.ts`, beside the
  existing `EXPLICIT_VAULT_SUFFIX`, appended through `describeMultiVault` by the
  builder. It describes `results_by_vault` and `failed_vaults` only.
- Reason: the `skipped_vaults` mention is false — no code path can populate the
  field. ADR-0010 makes descriptions the expensive, must-be-correct channel.
- Impact: model-facing text changes for all five tools. No behaviour an agent
  could rely on is lost: the removed sentence described a permanently empty
  field. The field itself stays in the response shape.

**`IFanOutResult` generic constraint** (contingent — see design D4)

- From: `T extends Record<string, unknown>`, which interfaces cannot satisfy,
  forcing four `& Record<string, unknown>` aliases plus an index-signature
  workaround in `search-notes.ts`.
- To: `T extends object`, if `npm run typecheck` confirms the generic spread
  still checks; the five workarounds are then deleted.
- Reason: the constraint is load-bearing for exactly one spread expression,
  which needs only `T extends object`.
- Impact: type-level only, no runtime change. If it does not typecheck clean,
  the constraint stays and the builder declares it once — the change proceeds
  either way.

Also: `search_notes` keeps its mid-description `- vault: ...` parameter line
(position-dependent, and a parameter listing rather than the fan-out contract),
and `docs/architecture/fan-out.md` gains the builder. No ADR is written or
edited — see design D6.

## Capabilities

### New Capabilities

- `multi-vault-dispatch`: how a fan-out-capable tool resolves the `vault`
  parameter, when it fans out versus targets one vault, what shape each branch
  returns, and what the tool description must state about the fan-out contract.

### Modified Capabilities

None. `hybrid-search`'s "Multi-query and multi-vault keep their shapes"
requirement and `vault-conventions-delivery`'s "the fan-out contract remains
described by each multi-vault-aware tool's own description" both stay true —
each tool still carries the contract in its own description; only the source of
that text becomes shared.

## Impact

**Code**

- New: `src/lib/multi-vault-tool.ts` (builder, `withVaultName`, `payloadOnly`).
- Modified: `src/lib/vault-param.ts` (`FAN_OUT_SUFFIX`), `src/lib/fan-out.ts`
  (generic constraint, contingent), and the five tool files —
  `src/modules/operations/tools/{list-tags,list-properties,query-notes,get-vault-overview}.ts`,
  `src/modules/semantic/tools/search-notes.ts`.

**Tests**

- New: `test/lib/multi-vault-tool.test.ts` — dispatch semantics against a fake
  registry, both single-vault shapes, prose composition.
- New assertion: all five registered tools carry byte-identical fan-out prose,
  and no tool description mentions `skipped_vaults`. This is the load-bearing
  deliverable — without it the change buys tidiness, not a drift guarantee.
- Existing per-tool description and shape assertions in
  `test/operations/tools.test.ts`, `test/operations/tools/*.test.ts`,
  `test/semantic/tools/*.test.ts` must stay green; assertions on the removed
  `skipped_vaults` sentence get updated.

**Docs**

- `docs/architecture/fan-out.md` — document the builder as the fan-out entry
  point for tools. This is the only doc that must state the new current state.
- No ADR is added or edited. ADR-0010's Consequences section describes the state
  when that decision was taken and stays as written; ADR-0008 makes
  `docs/architecture/` the living layer, and `docs/adr/INDEX.md` sanctions only
  a Status change for supersession, which this is not. See design D6.

**APIs / dependencies**

- MCP wire contract: unchanged apart from description text. No parameter added,
  renamed, or repurposed, so the MCP parameter dictionary is untouched and no
  major version is owed.
- No new runtime dependencies.
