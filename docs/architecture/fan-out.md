# Fan-Out

How multi-vault tools spread a single call across every registered vault and assemble the response.

## What it is

`src/lib/fan-out.ts` provides one helper — `runFanOut` — that takes a `VaultRegistry` and a per-vault async function and produces a uniform response shape: `{ results_by_vault, skipped_vaults, failed_vaults }`. Tools that need to answer for "all vaults" (when the caller omits the `vault:` parameter in multi-vault mode) reach it through the fan-out builder; tools that target a single named vault never touch fan-out at all.

## The two dispatch builders

Every vault-aware tool falls into one of two dispatch classes, and each class
has exactly one builder in `src/lib/`:

| class          | builder                                        | tools                                                                                                                   | suffix                   | resolution                                        |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| fan-out        | `buildMultiVaultTool` (`multi-vault-tool.ts`)  | `search_notes`, `query_notes`, `get_vault_overview`, `list_tags`, `list_properties`                                     | `FAN_OUT_SUFFIX`         | `runFanOut` when `vault` is omitted, else `resolveVault` |
| explicit-vault | `buildSingleVaultTool` (`single-vault-tool.ts`) | `read_notes`, `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`, `get_note_links`, `get_similar_notes`, `find_duplicates` | `EXPLICIT_VAULT_SUFFIX`  | `resolveVault`, or `resolveSemanticVault` under `semantic: true` |

A tool module never composes dispatch itself. It supplies only its domain
specifics — `name`, `title`, domain `description`, `inputShape`, `runForEntry`
(plus `single` for the fan-out class) — and the builder owns the rest: the
`vault` parameter via `vaultParamShape`, the shared suffix via
`describeMultiVault`, and the resolver call. That boundary is CI-enforced: an
ESLint `no-restricted-imports` override bans `src/modules/**` from importing
`lib/vault-param.js` or `lib/resolve-vault.js`, so `npm run lint` fails on any
tool that reaches around a builder.

`buildSingleVaultTool` discriminates on `semantic`. With `semantic: true` it
resolves through `resolveSemanticVault`, which owns the readiness gate
(`SEMANTIC_INDEX_BUILDING` / `SEMANTIC_DISABLED` / `SEMANTIC_INDEX_NOT_FOUND` —
see [`semantic-backend.md`](./semantic-backend.md)), and hands `runForEntry` an
entry whose `backend` is typed as present. There is no fan-out shape choice and
no post-suffix hook: nothing may follow the dispatch block.

Two single-vault shapes exist, and each tool names its own — there is no default:

| shape           | tools                                                | why                                           |
| --------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `withVaultName` | `list_tags`, `list_properties`, `get_vault_overview` | the payload has no vault identity of its own   |
| `payloadOnly`   | `query_notes`, `search_notes`                        | each result item already carries `vault`       |

`search_notes` additionally passes a `multiVaultNote` — one domain sentence
appended after the shared suffix — and keeps its own `- vault: ...` line inside
its mid-description `PARAMETERS:` block, which a generic builder cannot place.

Both builders place the dispatch block identically: as the description's own
final paragraph, joined with `\n\n`, whatever the shape of the domain prose.
`describeMultiVault` returns the bare block and no longer wraps it in a leading
space; placement belongs to the builders. That uniformity is what makes
suffix-last verifiable byte-wise — the earlier per-shape separator heuristic
existed only because description composition had two owners, and it is gone.

Nothing may follow the block. `create_note` used to append an overwrite warning
after it and `get_note_links` folded it into a `.join('\n')` array element;
both now end their domain description before the builder appends, with the
prose words unchanged.

Before the builders, all fourteen tools carried private copies of their
dispatch composition — the branch, the prose, the resolver call, and (for the
fan-out five) the `IFanOutResult` type bound; the fan-out prose copies had
drifted into three variants. `test/lib/fan-out-prose.test.ts` asserts all five
carry `FAN_OUT_SUFFIX` byte for byte, and `test/lib/single-vault-tool.test.ts`
pins the explicit-vault contract — `VAULT_REQUIRED` code and details, vault
advertisement, suffix placement, and semantic routing — once, through the
registration gate.

## Why it exists

Without a shared helper, every multi-vault tool would repeat the same loop: iterate the registry, run the per-vault op, decide what to do with rejections. The helper centralizes that pattern and — more importantly — owns the contract for how per-vault failures surface to the agent.

## The boundary contract

```
┌──────────────────────────────────────────────────────────────────┐
│  Tool handler                                                    │
│                                                                  │
│   Input validation     ──► throws ToolHandlerError               │
│   (zod, validators)        → MCP isError: true (one fatal)       │
│            │                                                     │
│            ▼                                                     │
│   runFanOut                per-vault throws ─► failed_vaults[]   │
│                             (Promise.allSettled — never throws)  │
│            │                                                     │
│            ▼                                                     │
│   { results_by_vault, skipped_vaults, failed_vaults }            │
└──────────────────────────────────────────────────────────────────┘
```

The line is sharp:

- **Before** fan-out begins (input parsing, validation, registry lookup for an explicit `vault:`): errors throw and become a single fatal `isError: true` response. These errors apply uniformly across vaults; surfacing one per vault would be misleading.
- **Inside** the per-vault `fn(entry)` callback: most throws — `ToolHandlerError` with a runtime code, plain `Error`, anything — get caught by the fan-out helper and mapped into a `failed_vaults` entry. The other vaults are unaffected.
- **Exception — fatal-class codes inside `fn(entry)`:** if a `ToolHandlerError` thrown from inside the callback carries a code in `FATAL_TOOL_ERROR_CODES` (owned by `src/lib/tool-response.ts`), the helper re-throws it as a single fatal error rather than capturing it. The classification answers the question "does this error belong to one vault, or to the whole tool call?" — input validation, vault-required, and vault-not-found all belong to the call. Some of these errors are thrown upstream of fan-out today (so the check acts mostly as defense in depth), but `runQueryNotes` and `runSearchForEntry` validate input per-vault for historical reasons, and the whitelist makes sure those errors still reach the caller as one actionable fatal, not as N identical `failed_vaults` entries.

## Response shape

```ts
interface IFanOutResult<T> {
  results_by_vault: Array<{ vault: string } & T>;
  skipped_vaults: ISkippedVault[]; // intentional pre-filter (e.g. no semantic index)
  failed_vaults: IFailedVault[]; // runtime crash during the per-vault call
}

interface ISkippedVault {
  vault: string;
  reason: string;
}

interface IFailedVault {
  vault: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

`failed_vaults` is always present — empty array when nothing failed. Always-present fields are discoverable for agents that learn the schema from the first response they see.

## skipped vs failed

|                  | `skipped_vaults`                              | `failed_vaults`                                    |
| ---------------- | ---------------------------------------------- | -------------------------------------------------- |
| Semantics        | Pre-filtered out due to known limitation       | Attempt was made and crashed                       |
| When             | Before `fn(entry)` is called                   | Inside `fn(entry)`                                 |
| Today's producer | None — `runFanOut` never skips a vault         | `mapRejectionToFailedVault` catches all rejections |
| Typical example  | "Semantic index unavailable for vault X"       | "Vault directory unreadable — permission denied"   |

The two are intentionally separate. Skipped is "expected, deterministic, startup-time"; failed is "unexpected, runtime, recoverable on retry". Merging them would erase that signal.

There used to be a second helper, `runSemanticFanOut`, that skipped vaults with `semanticAvailable: false` and listed them in `skipped_vaults`. When `search_notes` became hybrid it switched to `runFanOut` over **all** vaults — a vault without a semantic corpus still contributes matches, fused from its lexical leg alone (see [`rank-fusion.md`](./rank-fusion.md#degradation-modes)) — which left the semantic variant with no callers, and it was removed. `skipped_vaults` is therefore always `[]` today; the field stays in the response shape both for contract stability (always-present fields are discoverable for agents) and as the designated slot for a future fan-out tool that must pre-filter vaults. No tool description advertises the field, precisely because nothing populates it; `FAN_OUT_SUFFIX` describes `results_by_vault` and `failed_vaults` only.

## Rejection mapping

After `Promise.allSettled` completes, the helper:

1. **Scans for fatal rejections** via `isFatalToolError` (exported from `src/lib/tool-response.ts`). If any rejection is a `ToolHandlerError` whose `code` is in `FATAL_TOOL_ERROR_CODES`, re-throw the first such error. Fatal outcomes are deterministic across vaults, so even though every vault runs the same per-vault function and may all throw the same code, the agent only needs to see it once.
2. **Otherwise maps each rejection** via `mapRejectionToFailedVault` (private to `fan-out.ts`):
   - `ToolHandlerError` → preserves `code`, `message`, and `details` verbatim into `failed_vaults`.
   - Anything else (plain `Error`, primitive, etc.) → `{ code: 'INTERNAL_ERROR', message }`. Seeing `INTERNAL_ERROR` in `failed_vaults` is a smell — it means a per-vault code path threw something that wasn't a structured tool error. Fix the upstream throw site.

The classification (`FATAL_TOOL_ERROR_CODES` + `isFatalToolError`) lives next to `ToolHandlerError` rather than inside `fan-out.ts` because it's a property of the error taxonomy — "which errors belong to the call vs. one vault" is a question about the error, not about the helper that's currently asking it.

## Zero-success case

If every vault failed, `results_by_vault` is `[]` and `failed_vaults` carries them all. The helper still returns a structured response — it does not throw. Callers (and agents) can detect total failure with a one-liner and decide whether to retry, escalate, or surface the partial-error list to the user.

## Concurrency

Today: unbounded — every vault's `fn` runs in parallel via `Promise.allSettled`. Acceptable for the handful of vaults a user typically registers. If counts grow large enough to matter, a `p-limit`-style cap can be added without changing the response shape.
