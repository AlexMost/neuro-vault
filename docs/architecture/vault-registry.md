# Vault Registry

The index of per-vault primitives built once at server startup, consumed by both modules and every tool handler.

## What it is

`src/lib/vault-registry.ts` exports two things: the `VaultEntry` interface and `VaultRegistry.create`, an async factory that builds a `VaultRegistry` from a list of `VaultConfig` objects.

A `VaultEntry` bundles everything a module or tool handler needs to reach one vault:

| Field                       | Present when                             | Purpose                                                                   |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `name`                      | always                                   | Unique identifier (left side of `--vault name:path`, or `path.basename`)  |
| `path`                      | always                                   | Absolute path to the vault root                                           |
| `scope`                     | always                                   | `VaultScope` — which files are discoverable; see [`vault-scope.md`](./vault-scope.md) |
| `reader`                    | always                                   | `FsVaultReader` — direct disk reads, filtered through `scope`             |
| `provider`                  | always                                   | `FsVaultProvider` — every direct disk write to a single note: creates, daily notes, properties, in-place edits |
| `graph`                     | always                                   | `WikilinkGraphIndex` — lazy wikilink adjacency                            |
| `listMatchingPaths`         | always                                   | Factory-produced function for structured path queries                     |
| `readConventions`           | always                                   | Best-effort read of this vault's `.neuro-vault/for-external-agents.md`    |
| `filterExisting`            | always                                   | Filters vault-relative paths down to those still present on disk          |
| `backend`                   | the semantic module is enabled server-wide | `SemanticBackend` over this vault's own corpus (see [`semantic-backend.md`](./semantic-backend.md)) |

`scope` is built before anything else in entry construction: `VaultRegistry.create` calls `deps.scopeFactory({ vaultRoot: v.path })` first and passes the result into `readerFactory`, since `reader` needs it to filter `scan`. Production wires `scopeFactory` to `loadVaultScope`, which reads that vault's root `.gitignore` and `.neuro-vault/config.json` (see [`vault-scope.md`](./vault-scope.md) for the exclusion layers and the config failure contract) — so per-vault scope config loading happens at registry-build time, not per call.

`readConventions` and `filterExisting` are *per-vault capabilities*: small closures pre-bound to one vault's root, built by `conventionsReaderFactory` and `existingPathFilterFactory` in `IVaultEntryDeps` the same way `reader` and `provider` are. A consumer holding an entry gets the behaviour without threading `entry.path` anywhere, and a test substitutes it by passing its own function — no files on disk required. `filterExisting` exists because a corpus-derived path is a claim about the index and not a promise about the filesystem — the backend's watcher closes that gap only after its debounce, and only when no reconcile is already in flight — so every corpus-derived path is filtered through here before a tool returns it.

`backend` is built by `semanticBackendFactory`, one of two flags away from being present at all: the module-level `--no-semantic` flag decides whether a vault gets a backend in the first place (absent means no semantic tool is registered to read it), while the per-vault `"semantic": false` config key only decides whether a present backend is built `enabled: true` or `enabled: false`. `VaultRegistry.create` never awaits backend construction — a backend decides its own readiness live, reported through `status()` — so registry construction returns as soon as every vault's backend object exists, not once each is actually ready to serve. See [`semantic-backend.md`](./semantic-backend.md) for the state model and [ADR-0013](../adr/0013-own-embedding-corpus.md)/[ADR-0014](../adr/0014-background-corpus-freshness.md) for why.

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
- **Per-vault failures are data, not crashes.** A semantic backend never throws out of construction — a vault whose corpus is missing, incompatible, or fails to build reports `unavailable` through its own `status()`, live, rather than failing `VaultRegistry.create`. The server starts and every other vault, and every non-semantic capability of the failing one, works normally. `get_similar_notes` / `find_duplicates` surface the failure at call time as `SEMANTIC_INDEX_NOT_FOUND`; `search_notes` degrades to its lexical leg instead of erroring. See [`semantic-backend.md`](./semantic-backend.md).

## How it interacts

```
ServerConfig.vaults[]
      │
      ▼
VaultRegistry.create(config, deps)
      │  (one IVaultEntry per vault; each vault's semantic backend
      │   decides its own readiness live — see semantic-backend.md)
      ▼
VaultRegistry
      │
      ├─── createSemanticModule(registry, ...)   ──► semantic tools (search_notes, get_similar_notes, ...)
      └─── createOperationsModule(registry, ...) ──► operations tools + vault://overview resources
```

The registry does not feed the MCP `instructions` string. That is `SERVER_INSTRUCTIONS`, a constant with no registry dependency ([ADR-0012](../adr/0012-conventions-leave-the-instructions-channel.md)).

`server.ts` is the only caller of `VaultRegistry.create`. Both module factories receive the whole registry rather than individual entries so they can fan out without knowing vault count at compile time.

Tool handlers access the registry through three patterns:

1. **Single named vault** — `registry.require(input.vault)` when the caller supplied an explicit `vault` parameter.
2. **Single-vault fallback** — `registry.list()[0]` when `registry.isMulti()` is `false` and no vault was specified.
3. **Fan-out** — `registry.list()` for `search_notes`, `query_notes`, and `get_vault_overview` when `vault` is omitted in multi-vault mode.

## Invariants

- At least one `VaultEntry` is always present. Config-level validation rejects an empty `vaults` array before `VaultRegistry.create` is called.
- Vault names are unique. The registry builds a `Map<name, IVaultEntry>` at construction time; duplicate names would shadow silently, but `parseConfig` rejects them first.
- `backend` is present if and only if the semantic module is enabled server-wide (`--semantic`, the default). A per-vault `"semantic": false` in `.neuro-vault/config.json` still yields a present `backend` — one built `enabled: false`, permanently reporting `status().state === 'disabled'`.
- `status().reason` is always set when `status().state === 'unavailable'`; it is never set otherwise. See [`semantic-backend.md`](./semantic-backend.md) for the full state model.

## What it deliberately does not do

- **No lazy vault discovery.** Every vault must be declared explicitly via `--vault name:path`. The registry never scans the filesystem for vaults.
- **No on-the-fly re-registration.** The registry is built once and treated as immutable for the lifetime of the process. Adding a vault requires a server restart.
- **No readiness check during construction.** `VaultRegistry.create` never awaits or probes a backend — it decides, and reports, its own readiness after construction returns. Startup latency does not scale with corpus size or vault count; see [`semantic-backend.md`](./semantic-backend.md) for the startup states and the watcher that keeps them current afterward.
- **No vault routing logic.** The registry answers "give me vault X" or "list all vaults". Deciding which vault(s) a given tool call should target is the tool handler's concern.
