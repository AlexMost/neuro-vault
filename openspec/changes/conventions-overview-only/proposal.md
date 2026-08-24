Tracked by: #93

## Why

The MCP `instructions` channel does not deliver the vault conventions it advertises. Claude Code truncates `instructions` at 2048 characters **per server**, not per vault, so with several vaults registered the first one consumes the budget and every later block arrives as nothing — measured on 15.3.0 in both registration orders.

Because `buildServerInstructions` emits conventions **first**, the cut lands on the server preamble instead: any conventions file over ~1,316 characters deletes the preamble entirely, and our own docs recommend files up to 8,000. The CI budget guard is asymmetric — it catches five characters added to the preamble, but not a vault owner adding 800 to their own file. And the channel has no truncation signal, so every one of these failures is silent.

We are paying a measured cost for a benefit that was never measured.

## What Changes

**Conventions in the `instructions` channel**

- From: `buildServerInstructions(registry)` reads every vault's `.neuro-vault/for-external-agents.md` and emits one conventions block per vault ahead of the server preamble.
- To: `instructions` is a constant — the static preamble plus a one-line pointer to `get_vault_overview`. No vault content is read.
- Reason: the emitted blocks do not arrive. Cutting the channel also removes the dead preamble, the multi-vault first-come-takes-all, and the need for both a startup budget warning and budget-aware multi-vault composition.
- Impact: non-breaking for the overview channel. An owner who relies on conventions reaching the system prompt *without* a tool call loses that — a path that already delivers nothing to sub-agents, nothing past ~1,316 characters, and nothing to any vault after the first.

**`buildServerInstructions` shape**

- From: `async (registry: IVaultRegistry) => Promise<string>`.
- To: a module constant. It no longer depends on the registry and no longer awaits.
- Reason: with no per-vault content to compose, the function has no inputs.
- Impact: internal — one call site (`startNeuroVaultServer`) and one test file.

**The instructions budget guard**

- From: a suite asserting conventions ordering and that a ~1,200-character fixture survives inside 2048 characters.
- To: one assertion that the composed `instructions` are a constant under the cap, with no dependence on vault configuration.
- Reason: the invariant it guarded is replaced by a stronger one that no vault owner can break.
- Impact: multi-vault block-attribution tests are removed with the behaviour they described.

**Documentation**

- The README sentence promising "one clearly-labelled block per vault" is **deleted**, not rewritten — the accurate version describes a behaviour being removed.
- No doc offers 8,000 characters as an `instructions` budget; `CONVENTIONS_CHAR_CAP` is documented only as the overview channel's cap, which it always was.
- A new ADR-0012, building on ADR-0010, records that duplicating owner content into `instructions` measured net-negative and why the pointer suffices where the text did not.
- Docs note that in Claude Code `/mcp reconnect` does not rebuild the session's system prompt, so an `instructions` change is only observable in a fresh session.

**Explicit non-goal**

Removing conventions frees ~1,300 characters of the 2048 budget. The preamble is **not** grown to fill it. Anything a tool can say about itself still belongs on that tool's description — ADR-0010 is applied here, not weakened.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `vault-conventions-delivery`: the requirements governing the `instructions` channel change. "A vault's conventions survive the instructions truncation budget" is removed — conventions no longer appear in `instructions` at all, so its ordering and in-budget scenarios describe a behaviour that ceases to exist. "Composed instructions do not restate tool descriptions" is modified: the composed string becomes a constant carrying the preamble plus a pointer to `get_vault_overview`, independent of vault configuration. "Each vault's conventions travel with that vault" is modified to drop its per-vault `instructions` block clause; its overview fan-out clauses are unchanged. "An unreadable conventions file never fails a call" is modified to drop its instructions-composition clause. Every overview-channel requirement — presence/absence, call-time freshness, visible truncation, fan-out attribution — is untouched.

## Impact

**Code**

- `src/server.ts` — `buildServerInstructions` becomes a constant; the `readVaultConventions` import and the registry parameter go away; the preamble comment describing the conventions-first ordering is rewritten.
- `src/lib/obsidian/vault-conventions.ts` — unchanged. `readVaultConventions`, `capConventions`, and `CONVENTIONS_CHAR_CAP` all stay; only the comment referring to the `instructions` channel needs a look.
- `src/lib/vault-registry.ts` — unchanged. `IVaultEntry.readConventions` stays load-bearing: `src/modules/operations/tools/get-vault-overview.ts` and `src/modules/operations/resources/vault-overview.ts` are its remaining consumers.
- `src/lib/obsidian/vault-overview.ts` — unchanged.

**Tests**

- `test/server-instructions.test.ts` — the 2048-character budget suite collapses; conventions-ordering and multi-vault attribution tests are removed.
- Overview-channel conventions tests (`test/lib/obsidian/vault-overview.test.ts`, `test/lib/obsidian/vault-conventions.test.ts`, `test/operations/tools/get-vault-overview.test.ts`, `test/operations/resources/vault-overview.test.ts`) are unaffected.

**Docs**

`README.md`, `docs/architecture/vault-conventions.md`, `docs/architecture/vault-registry.md`, `docs/architecture/obsidian-lib.md`, `docs/architecture/mcp-server-shape.md`, `docs/guide/configuration.md`, plus new `docs/adr/0012-*.md` and its `docs/adr/INDEX.md` entry.

**No change**

MCP tool contracts, the parameter dictionary, error codes, and the `get_vault_overview` / `vault://overview` response shapes are all untouched. No dependency changes.
