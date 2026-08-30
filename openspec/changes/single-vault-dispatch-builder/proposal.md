# Proposal — single-vault-dispatch-builder

Tracked by [GitHub issue #111](https://github.com/AlexMost/neuro-vault/issues/111).

## Why

`buildMultiVaultTool` owns the multi-vault dispatch contract for only the five fan-out tools. The nine single-vault tools each hand-roll the other half in three pieces — `vaultParamShape` spread, `describeMultiVault(…, EXPLICIT_VAULT_SUFFIX)` concatenation, and a `resolveVault` call restating the tool's own name literal — 27 repetitions with no owner. The "dispatch prose goes last" invariant is enforced by nothing and already broken twice (`create-note.ts`, `get-note-links.ts`), and split description ownership forced a separator heuristic into `buildMultiVaultTool`. Only 3 of 9 tools have a `VAULT_REQUIRED` behaviour test.

## What Changes

**Tool construction for the nine single-vault tools**

- From: each tool file composes the vault param, dispatch suffix, and resolver call by hand.
- To: each supplies `name`, domain description, `inputShape` (`vault?: never`), and `runForEntry(entry, input)` to a new `buildSingleVaultTool(registry, spec)`; the builder contributes the `vault` param, appends `EXPLICIT_VAULT_SUFFIX` last, and calls `resolveVault` (or `resolveSemanticVault` when `semantic: true`).
- Reason: one owner for the explicit-vault dispatch contract, mirroring the fan-out builder.
- Impact: non-breaking — parameter names, dispatch prose wording, and error codes unchanged.

**Suffix placement**

- From: `create_note` carries prose after the suffix; `get_note_links` folds the suffix into a `.join('\n')` element; `buildMultiVaultTool` sniffs `spec.description.includes('\n')` to pick a separator.
- To: both builders place the dispatch block as its own final paragraph; the heuristic is deleted. Description words are byte-identical; only joining whitespace normalizes.
- Reason: suffix-last becomes structurally guaranteed instead of conventionally hoped.
- Impact: non-breaking (whitespace-only description change for clients).

**Enforcement and coverage**

- `src/modules/**` is lint-banned from importing `lib/vault-param.js` and `lib/resolve-vault.js` (ESLint `no-restricted-imports`, enforced in CI via `npm run lint`).
- `VAULT_REQUIRED` behaviour is tested once at the builder level through the registration gate (ADR-0015) and thereby holds for all nine tools.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `multi-vault-dispatch`: the capability currently covers only the fan-out class. It gains requirements for the explicit-vault class — one builder owns the `vault` param, resolver call, and suffix for all nine single-vault tools; explicit-vault resolution semantics (`VAULT_REQUIRED` when omitted in multi-vault mode); semantic tools route through the readiness gate; and the dispatch block is the final paragraph of every description, replacing the separator heuristic.

## Impact

- **New**: `src/lib/single-vault-tool.ts`, `test/lib/single-vault-tool.test.ts`.
- **Modified**: the nine tool files under `src/modules/operations/tools/` and `src/modules/semantic/tools/`; `src/lib/multi-vault-tool.ts` (heuristic removed); `src/lib/vault-param.ts` (`describeMultiVault` drops leading-space wrapping); `eslint.config.*` (import boundary); tests pinning exact description strings (`test/lib/multi-vault-tool.test.ts`, description assertions elsewhere as they surface); `docs/architecture/fan-out.md` + docs sweep.
- **Unchanged**: the five fan-out tools' spec interface, MCP parameter dictionary (ADR-0005), error codes (ADR-0003), tool response envelope.
- Delivery: one PR (builder without call sites is dead code; the lint boundary needs all nine migrated).
