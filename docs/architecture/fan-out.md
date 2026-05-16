# Fan-Out

How multi-vault tools spread a single call across every registered vault and assemble the response.

## What it is

`src/lib/fan-out.ts` provides two helpers — `runFanOut` and `runSemanticFanOut` — that take a `VaultRegistry` and a per-vault async function and produce a uniform response shape: `{ results_by_vault, skipped_vaults, failed_vaults }`. Tools that need to answer for "all vaults" (when the caller omits the `vault:` parameter in multi-vault mode) call one of these helpers; tools that target a single named vault call `resolveVault` / `resolveSemanticVault` directly and never touch fan-out.

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
│   runFanOut /              per-vault throws ─► failed_vaults[]   │
│   runSemanticFanOut         (Promise.allSettled — never throws)  │
│            │                                                     │
│            ▼                                                     │
│   { results_by_vault, skipped_vaults, failed_vaults }            │
└──────────────────────────────────────────────────────────────────┘
```

The line is sharp:

- **Before** fan-out begins (input parsing, validation, registry lookup for an explicit `vault:`): errors throw and become a single fatal `isError: true` response. These errors apply uniformly across vaults; surfacing one per vault would be misleading.
- **Inside** the per-vault `fn(entry)` callback: every throw — `ToolHandlerError`, plain `Error`, anything — gets caught by the fan-out helper and mapped into a `failed_vaults` entry. The other vaults are unaffected.

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

|                  | `skipped_vaults`                                                 | `failed_vaults`                                    |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| Semantics        | Pre-filtered out due to known limitation                         | Attempt was made and crashed                       |
| When             | Before `fn(entry)` is called                                     | Inside `fn(entry)`                                 |
| Today's producer | `runSemanticFanOut` skips vaults with `semanticAvailable: false` | `mapRejectionToFailedVault` catches all rejections |
| Typical example  | "Smart Connections index missing for vault X"                    | "Obsidian CLI rejected — daemon not running"       |

The two are intentionally separate. Skipped is "expected, deterministic, startup-time"; failed is "unexpected, runtime, recoverable on retry". Merging them would erase that signal.

## Rejection mapping

`mapRejectionToFailedVault` (private to `fan-out.ts`):

- `ToolHandlerError` → preserves `code`, `message`, and `details` verbatim.
- Anything else (plain `Error`, primitive, etc.) → `{ code: 'INTERNAL_ERROR', message }`. Seeing `INTERNAL_ERROR` in `failed_vaults` is a smell — it means a per-vault code path threw something that wasn't a structured tool error. Fix the upstream throw site.

## Zero-success case

If every vault failed, `results_by_vault` is `[]` and `failed_vaults` carries them all. The helper still returns a structured response — it does not throw. Callers (and agents) can detect total failure with a one-liner and decide whether to retry, escalate, or surface the partial-error list to the user.

## Concurrency

Today: unbounded — every vault's `fn` runs in parallel via `Promise.allSettled`. Acceptable for the handful of vaults a user typically registers. If counts grow large enough to matter, a `p-limit`-style cap can be added without changing the response shape.
