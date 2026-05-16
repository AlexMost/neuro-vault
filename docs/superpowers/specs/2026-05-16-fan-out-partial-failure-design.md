# Fan-Out Partial Failure

## Goal

Make multi-vault fan-out tools resilient to per-vault failures. Today `runFanOut` and `runSemanticFanOut` use `Promise.all`, so a single failed vault rejects the whole call and the agent sees nothing from the other vaults that succeeded. After this change, per-vault failures are collected into a new `failed_vaults` array on the response (parallel to the existing `skipped_vaults`), and successful vaults still return their results.

The boundary is sharp: anything thrown from inside the per-vault `fn(entry)` callback becomes a `failed_vaults` entry. Anything thrown before fan-out begins (input validation, schema coercion, registry lookup for an explicit `vault:`) still throws and propagates as a fatal error — those failures apply uniformly across all vaults and would be misleading to surface 5×.

## Non-goals

- **Single-vault behavior.** When there's only one registered vault, or when the caller passes an explicit `vault: 'X'`, fan-out is not used. Errors throw as today. Partial-failure semantics are only meaningful when the server is answering on behalf of several vaults at once.
- **Harmonizing `skipped_vaults` with `failed_vaults`.** They look similar but mean different things — skipped is "pre-filtered out due to known limitation"; failed is "attempt was made and crashed at call time". Merging them would erase a useful semantic distinction. They stay separate.
- **Per-call retry of failed vaults.** Out of scope. The agent retries by re-invoking the tool.
- **Cancellation / fail-fast options.** Out of scope. `Promise.allSettled` always waits for all promises; no `AbortSignal` plumbing in this iteration.
- **Concurrency limits.** All vaults run in parallel, as today. A `p-limit`-style cap can be added later if vault counts ever grow into double digits.

## Architecture

### The boundary contract

```
                                       │
                                       │
    ┌──────────────────────────────────▼──────────────────────────────────┐
    │  Tool handler                                                       │
    │                                                                     │
    │   ┌─────────────────────┐                                           │
    │   │ Input validation    │  ──► throws ToolHandlerError              │
    │   │ (zod, validators)   │      → MCP isError: true (one fatal)      │
    │   └─────────────────────┘                                           │
    │              │                                                      │
    │              ▼                                                      │
    │   ┌─────────────────────┐                                           │
    │   │ runFanOut /         │                                           │
    │   │ runSemanticFanOut   │  per-vault throws ─►  failed_vaults[]     │
    │   │  (Promise.allSettled)│                                          │
    │   └─────────────────────┘                                           │
    │              │                                                      │
    │              ▼                                                      │
    │   { results_by_vault, skipped_vaults, failed_vaults }               │
    │                                                                     │
    └─────────────────────────────────────────────────────────────────────┘
```

Inside `fn(entry)`, **any throw** — `ToolHandlerError`, plain `Error`, anything — gets caught by the fan-out helper and mapped into a `failed_vaults` entry. The helper itself never throws (other than for assertion violations in its own argument shape, which would be a programmer bug).

### Response shape

```ts
// src/lib/fan-out.ts — after

export interface ISkippedVault {
  vault: string;
  reason: string; // unchanged: kept for backward symmetry with semantic skip
}

export interface IFailedVault {
  vault: string;
  error: {
    code: string; // matches ToolHandlerError.code (plain string at the type level)
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface IFanOutResult<T extends Record<string, unknown>> {
  results_by_vault: Array<{ vault: string } & T>;
  skipped_vaults: ISkippedVault[];
  failed_vaults: IFailedVault[]; // always present; empty array when nothing failed
}
```

Note on the `code` type: `ToolHandlerError.code` is declared as plain `string` in `src/lib/tool-response.ts` (the `ToolHandlerErrorCode` union in `src/modules/semantic/types.ts` is a narrower documentation type used only by the semantic-module dependencies type, and does **not** cover the operations / CLI codes like `CLI_NOT_FOUND`, `NOTE_EXISTS`, `PROPERTY_NOT_FOUND`, etc.). Typing `IFailedVault.error.code` as `string` matches `ToolHandlerError`'s declared shape exactly. Tightening that union is a separate concern.

`failed_vaults` is **always present**, parallel to `skipped_vaults`. Empty arrays are cheap; always-present fields are discoverable for agents that learn schemas from the first response they see.

### `runFanOut` implementation

```ts
export async function runFanOut<T extends Record<string, unknown>>(
  registry: IVaultRegistry,
  fn: (entry: IVaultEntry) => Promise<T>,
): Promise<IFanOutResult<T>> {
  const entries = registry.list();
  const settled = await Promise.allSettled(
    entries.map((entry) => fn(entry).then((value) => ({ vault: entry.name, ...value }))),
  );

  const results: Array<{ vault: string } & T> = [];
  const failed: IFailedVault[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      failed.push(mapRejectionToFailedVault(entries[i].name, outcome.reason));
    }
  }
  return { results_by_vault: results, skipped_vaults: [], failed_vaults: failed };
}
```

### `runSemanticFanOut` implementation

Same shape change. Skipped vaults stay first-class; failed vaults are added.

```ts
export async function runSemanticFanOut<T extends Record<string, unknown>>(
  registry: IVaultRegistry,
  fn: (entry: IVaultEntry) => Promise<T>,
): Promise<IFanOutResult<T>> {
  const eligible = registry.semanticAvailableEntries();
  const skipped: ISkippedVault[] = registry
    .list()
    .filter((e) => !e.semanticAvailable)
    .map((e) => ({ vault: e.name, reason: 'SEMANTIC_INDEX_NOT_FOUND' }));

  const settled = await Promise.allSettled(
    eligible.map((entry) => fn(entry).then((value) => ({ vault: entry.name, ...value }))),
  );

  const results: Array<{ vault: string } & T> = [];
  const failed: IFailedVault[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      failed.push(mapRejectionToFailedVault(eligible[i].name, outcome.reason));
    }
  }
  return { results_by_vault: results, skipped_vaults: skipped, failed_vaults: failed };
}
```

### Rejection mapping

```ts
function mapRejectionToFailedVault(vault: string, reason: unknown): IFailedVault {
  if (reason instanceof ToolHandlerError) {
    return {
      vault,
      error: {
        code: reason.code,
        message: reason.message,
        ...(reason.details ? { details: reason.details } : {}),
      },
    };
  }
  return {
    vault,
    error: {
      code: 'INTERNAL_ERROR',
      message: reason instanceof Error ? reason.message : String(reason),
    },
  };
}
```

The helper is defensive about non-`ToolHandlerError` throws so a stray bug in one vault's code path can't take down the multi-vault response. `INTERNAL_ERROR` is used as a string literal — no union update needed (see the note on `code` type above).

## Affected tools

Six tools use fan-out. Each gets the new `failed_vaults` field automatically through `IFanOutResult<T>`; no per-tool code changes are required. Tool-level tests should add a "one vault throws" scenario, but the call sites do not need to be modified.

| Tool                 | Helper              | File                                                 |
| -------------------- | ------------------- | ---------------------------------------------------- |
| `list_tags`          | `runFanOut`         | `src/modules/operations/tools/list-tags.ts`          |
| `list_properties`    | `runFanOut`         | `src/modules/operations/tools/list-properties.ts`    |
| `query_notes`        | `runFanOut`         | `src/modules/operations/tools/query-notes.ts`        |
| `get_vault_overview` | `runFanOut`         | `src/modules/operations/tools/get-vault-overview.ts` |
| `search_notes`       | `runSemanticFanOut` | `src/modules/semantic/tools/search-notes.ts`         |

(Note: `search_notes` is the only `runSemanticFanOut` consumer today.)

## Error handling

### What lives where

- **Per-vault errors** (anything thrown inside `fn(entry)`): caught by the fan-out helper. Surfaced in `failed_vaults`. `ToolHandlerError` preserved verbatim. Unknown errors become `{ code: 'INTERNAL_ERROR', message }`.
- **Validation errors** thrown before fan-out (zod parse failure, custom validators, registry lookup for explicit `vault:`): still throw → MCP wrapper converts to `isError: true` response. These apply globally and are correctly fatal.
- **Programmer-bug errors** (e.g. `runFanOut` called with a non-`IVaultRegistry`): would surface as TypeScript errors before runtime; if they slip through, `Promise.allSettled` reports them too and they end up as `INTERNAL_ERROR` in `failed_vaults`.

### `INTERNAL_ERROR` code

Reserved for "the per-vault `fn` threw something that wasn't a `ToolHandlerError`" — the defensive fallback path inside `mapRejectionToFailedVault`. Used as a plain string literal (no union to update, since `ToolHandlerError.code` is typed as `string`). Production code should never produce this in normal operation; seeing it in `failed_vaults` is a signal to look at logs and fix the upstream throw site.

### Zero-success case

If all vaults failed (`results_by_vault.length === 0 && failed_vaults.length > 0`), the helper still returns the structured response — it does **not** throw. Reasoning:

- The response is uniform: callers always get `{ results_by_vault, skipped_vaults, failed_vaults }`. No special case to branch on at the wrapper or agent level.
- Agents can detect total failure trivially (`results_by_vault.length === 0`) and choose their own remediation (retry, escalate, ask user).
- Throwing only on 100% failure adds a discontinuity that's hard to test and easy to forget.

## Testing strategy

### Unit tests for `runFanOut` and `runSemanticFanOut`

Add a new `describe('partial failure', …)` block in `test/lib/fan-out.test.ts`:

- **One of N vaults throws `ToolHandlerError`** → result has N-1 successes + 1 `failed_vaults` entry with the same code/message/details.
- **One of N vaults throws plain `Error`** → result has N-1 successes + 1 `failed_vaults` entry with `code: 'INTERNAL_ERROR'`, `message` = the error's message.
- **All vaults throw** → `results_by_vault: []`, `failed_vaults` has N entries, helper does not throw.
- **No vault throws** → `failed_vaults: []` (present, empty).
- **`runSemanticFanOut` only**: a vault that is `semanticAvailable: false` appears in `skipped_vaults` (as today); a vault that is `semanticAvailable: true` but whose `fn` throws appears in `failed_vaults`. The two can co-exist in the same response.
- **Order preservation**: `results_by_vault` keeps the registry's order for successes; `failed_vaults` keeps the registry's order for failures.

### Tool-level smoke tests

For each of the 6 fan-out tools, add (or extend an existing) test that:

- Simulates one vault rejecting (e.g. CLI binary not found for that vault's provider) and asserts the response contains `failed_vaults` with the right vault name and the right error code.
- Asserts that successful vaults' results are unaffected.

These don't need to be exhaustive — one such test per tool is enough to lock the integration.

### Single-vault regression

Add a small smoke test confirming that in single-vault mode (or when `vault: 'X'` is passed explicitly), errors still throw and do not appear in any `failed_vaults` array — because the fan-out helpers are not invoked on those paths.

## Documentation

- **New: `docs/architecture/fan-out.md`** — describes the boundary contract ("fan-out is partial-OK; everything else throws"), the response shape, the difference between `skipped_vaults` and `failed_vaults`, and the mapping rule for rejections.
- **Update: `docs/guide/vault-operations.md`** — add a short paragraph under each fan-out tool's section noting that responses include `failed_vaults` in multi-vault mode.
- **Update: `docs/guide/configuration.md`** (or wherever the multi-vault mode intro lives) — mention that per-vault failures are surfaced inline, not as a top-level error.

## Migration / release

Adding `failed_vaults` to every fan-out tool response is a **schema-additive** change. Agents that don't check for the field continue to work — they just lose the visibility into partial failures. Strict schema-validating clients (none known today) would see a new property they don't expect; this is the breaking-change axis.

Bundled into the 7.0.0 release (already triggered by the `--operations` flag removal in the capability-typed-vault-resolvers PR). One major version, two breaking-change footers in the changelog.

If PR #36 (capability-typed-vault-resolvers) has not yet merged when work on this spec begins, the implementation branch should still target `main`. The two changes do not conflict at the source level — `fan-out.ts` was untouched in PR #36, and this spec does not touch `IVaultEntry`. Merge order is interchangeable; both will land in v7.0.0.

## Definition of Done

A change is complete when every item below is true:

- `IFanOutResult<T>` has a required `failed_vaults: IFailedVault[]` field.
- `IFailedVault` shape matches the spec: `{ vault, error: { code: string, message, details? } }`.
- `runFanOut` and `runSemanticFanOut` both use `Promise.allSettled` and never throw on per-vault rejection (helper-level assertion violations excluded).
- `mapRejectionToFailedVault` preserves `ToolHandlerError` code/message/details verbatim; maps unknown throws to `{ code: 'INTERNAL_ERROR' }`.
- All 6 fan-out tools return the new field automatically (no per-tool code change needed; verify via type system).
- Unit tests in `test/lib/fan-out.test.ts` cover: partial failure (ToolHandlerError), partial failure (plain Error), all-fail, all-succeed, skipped+failed co-existence, order preservation.
- Tool-level smoke tests cover at least one "one vault throws" scenario per fan-out tool.
- Single-vault regression test confirms throws still propagate when fan-out is bypassed.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- `docs/architecture/fan-out.md` exists and documents the contract.
- User-facing docs (`vault-operations.md`, `configuration.md`) mention `failed_vaults` where appropriate.
- Conventional Commit with `feat!:` marker (or grouped under the existing 7.0.0 breaking-change set if released together).
