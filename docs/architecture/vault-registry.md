# Vault Registry

The index of per-vault primitives built once at server startup, consumed by both modules and every tool handler.

## What it is

`src/lib/vault-registry.ts` exports two things: the `VaultEntry` interface and `VaultRegistry.create`, an async factory that builds a `VaultRegistry` from a list of `VaultConfig` objects.

A `VaultEntry` bundles everything a module or tool handler needs to reach one vault:

| Field                       | Present when                             | Purpose                                                                   |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `name`                      | always                                   | Unique identifier (left side of `--vault name:path`, or `path.basename`)  |
| `path`                      | always                                   | Absolute path to the vault root                                           |
| `reader`                    | always                                   | `FsVaultReader` — direct disk reads                                       |
| `writer`                    | always                                   | `FsVaultWriter` — direct disk writes for in-place edits                   |
| `provider`                  | always                                   | `FsVaultProvider` — direct disk creates, daily notes, properties, tags   |
| `graph`                     | always                                   | `WikilinkGraphIndex` — lazy wikilink adjacency                            |
| `listMatchingPaths`         | always                                   | Factory-produced function for structured path queries                     |
| `corpus`                    | `--semantic` enabled AND corpus loadable | `SmartConnectionsCorpusIndex` wrapping the `.smart-env/multi/` data       |
| `semanticAvailable`         | always                                   | `true` only when `corpus` is set                                          |
| `semanticUnavailableReason` | when `semanticAvailable === false`       | Human-readable explanation (missing directory, empty corpus, parse error) |

The `VaultRegistry` interface exposes a small, stable API:

```typescript
interface VaultRegistry {
  get(name: string): IVaultEntry | undefined;
  require(name: string): IVaultEntry; // throws VAULT_NOT_FOUND if missing
  list(): IVaultEntry[];
  isMulti(): boolean;
  names(): string[];
}
```

## Why it exists

Before the registry, per-vault wiring lived inline in each module factory, which meant every module duplicated reader/provider construction and every tool handler received multiple config arguments. The registry centralises all of that:

- **Modules become stateless consumers.** `createSemanticModule(registry, ...)` and `createOperationsModule(registry, ...)` pull the `VaultEntry` they need instead of receiving raw paths and constructing things themselves.
- **Tool handlers are vault-agnostic.** A handler receives `(input, registry)`, calls `registry.require(name)` for a named vault, or fans out via `registry.list()`. No handler owns startup wiring.
- **Per-vault failures are data, not crashes.** If one vault's `.smart-env/multi/` is missing or empty, `VaultRegistry.create` catches the throw, sets `semanticAvailable: false` and records the reason in `semanticUnavailableReason`. The server starts and the healthy vaults work normally. The failure surfaces at call time as `SEMANTIC_INDEX_NOT_FOUND`.

## How it interacts

```
ServerConfig.vaults[]
      │
      ▼
VaultRegistry.create(config, deps)
      │  (one IVaultEntry per vault, per-vault corpus errors caught → semanticAvailable:false)
      ▼
VaultRegistry
      │
      ├─── createSemanticModule(registry, ...)   ──► semantic tools (search_notes, get_similar_notes, ...)
      ├─── createOperationsModule(registry, ...) ──► operations tools + vault://overview resources
      └─── buildServerInstructions(registry)     ──► MCP instructions block (multi-vault section)
```

`server.ts` is the only caller of `VaultRegistry.create`. Both module factories receive the whole registry rather than individual entries so they can fan out without knowing vault count at compile time.

Tool handlers access the registry through three patterns:

1. **Single named vault** — `registry.require(input.vault)` when the caller supplied an explicit `vault` parameter.
2. **Single-vault fallback** — `registry.list()[0]` when `registry.isMulti()` is `false` and no vault was specified.
3. **Fan-out** — `registry.list()` for `search_notes`, `query_notes`, and `get_vault_overview` when `vault` is omitted in multi-vault mode.

## Invariants

- At least one `VaultEntry` is always present. Config-level validation rejects an empty `vaults` array before `VaultRegistry.create` is called.
- Vault names are unique. The registry builds a `Map<name, IVaultEntry>` at construction time; duplicate names would shadow silently, but `parseConfig` rejects them first.
- `semanticAvailable === true` if and only if `corpus` is defined and non-empty.
- `semanticUnavailableReason` is always set when `semanticAvailable === false` and `--semantic` was passed.

## What it deliberately does not do

- **No lazy vault discovery.** Every vault must be declared explicitly via `--vault name:path`. The registry never scans the filesystem for vaults.
- **No on-the-fly re-registration.** The registry is built once and treated as immutable for the lifetime of the process. Adding a vault requires a server restart.
- **No health checks beyond initial snapshot.** Each `corpus` is probed once during `VaultRegistry.create` (a `corpus.snapshot()` call checks that the result is non-empty). After that, staleness detection is the corpus index's own responsibility.
- **No vault routing logic.** The registry answers "give me vault X" or "list all vaults". Deciding which vault(s) a given tool call should target is the tool handler's concern.
