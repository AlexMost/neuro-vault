# Module Structure

How the server is split into pluggable modules and how they are wired together at startup.

## What it is

The codebase is organized into two modules under `src/modules/`:

- `semantic/` — embedding-based search over a Smart Connections corpus (in-memory cosine search) — 4 tools
- `operations/` — direct vault operations — 12 tools, grouped as note body (`read_notes`, `create_note`, `edit_note`, `read_daily`), structured queries (`query_notes`), frontmatter properties (`set_property`, `read_property`, `remove_property`, `list_properties`), tags (`list_tags`), and vault overview (`get_vault_overview`)

Each module exports `createXModule(config, deps) → { tools: ToolRegistration[], resources: ResourceRegistration[], warmup? }`. `src/server.ts` aggregates registrations from enabled modules and registers them with the underlying `McpServer`. Modules also expose `resources: ResourceRegistration[]`. Operations exposes one — `vault://overview`, a JSON snapshot of vault structure backed by the same `computeVaultOverview` function that powers the `get_vault_overview` tool. Semantic exposes no resources today. A module with no resources returns an empty array.

## Why it exists

Different users want different things. Some have Smart Connections set up and want semantic search; some just want vault operations from their AI assistant; some want both. Splitting along this axis means:

- Users can disable semantic search (`--no-semantic`) to avoid the startup cost of the embedding-model load and corpus parse. Operations tools are always registered — they are pure-object factories with no startup cost; missing-CLI failures surface per call.
- Each module is independently testable and reasonable in isolation.
- Adding a third module later (e.g. structural search) is a localized change — the server-level wiring is uniform.

## Boundaries

- A module exposes only `tools` (and an optional `warmup`). Anything else is internal.
- Modules do not call each other. If two modules ever need to share data, that data should live in `src/lib/` and both consume it from there.
- Module-specific types live inside the module (`modules/<name>/types.ts`). `src/types.ts` only contains the shared `ServerConfig`.

## Wiring

```
parseConfig(argv) → ServerConfig
   │
   ▼
VaultRegistry.create(config, deps) → VaultRegistry
   │  (one IVaultEntry per --vault name:path; per-vault corpus errors
   │   are caught and stored as semanticAvailable:false, not thrown)
   ▼
startNeuroVaultServer(config, deps)
   │
   ├─ if config.semantic.enabled  → createSemanticModule(registry, ...)  → registrations[]
   ├─ if config.operations.enabled → createOperationsModule(registry, ...) → registrations[]
   │
   └─ register all → server.connect(transport) → warmup
```

If both modules are disabled, startup fails fast with a clear error.

Both module factories receive the whole `VaultRegistry` rather than individual vault configs. Tool handlers reach into the registry at call time — either targeting a named vault (`registry.require(name)`) or fanning out across all vaults (`registry.list()` / `registry.semanticAvailableEntries()`). See [`vault-registry.md`](./vault-registry.md) for details.

Operations tools are always registered — their construction is a zero-cost pure-object factory with no warmup or initialization. Errors related to missing CLI or unavailable Obsidian surface at tool-call time rather than at startup.

## End-to-end shape

```mermaid
flowchart LR
    Client[MCP Client<br/>Claude Code / Cursor / Windsurf]
    subgraph Server[neuro-vault-mcp]
        direction TB
        CLI[cli.ts<br/>config + flags]
        Core[server.ts<br/>tool registration]
        Registry[VaultRegistry<br/>one IVaultEntry per vault]
        subgraph Semantic[Semantic module]
            direction TB
            Retrieval[Retrieval policy<br/>quick / deep]
            Embed[Embedding service<br/>bge-micro-v2]
            Search[Search engine<br/>cosine similarity]
        end
        subgraph Operations[Operations module]
            direction TB
            Provider[VaultProvider]
            CLIProv[ObsidianCLIProvider<br/>execFile]
        end
        CLI --> Core
        Core --> Registry
        Registry --> Semantic
        Registry --> Operations
        Retrieval --> Embed
        Retrieval --> Search
        Provider --> CLIProv
    end
    Vault[(Obsidian vault<br/>.smart-env/multi/*.ajson)]
    Obs[Obsidian app<br/>+ obsidian CLI]
    Client <-->|stdio / MCP| Core
    Search -. reads at startup .-> Vault
    CLIProv -. execFile .-> Obs
```

The `VaultRegistry` is built once at startup from the list of vaults declared via `--vault name:path` flags (repeatable). Each entry bundles a reader, optional writer and provider, wikilink graph, and — when the vault's `.smart-env/multi/` is loadable — a corpus index. When a vault's corpus cannot be loaded (missing directory, empty index, parse error), the entry's `semanticAvailable` field is `false` and the reason is recorded as a string; startup does not fail. The failure surfaces at semantic-tool-call time.

The semantic module loads `.smart-env/multi/*.ajson` into memory once at startup and keeps it there. The operations module is a thin wrapper around the `obsidian` CLI invoked via `execFile`. Reads (`read_notes`, `query_notes`) go directly to the file system via `FsVaultReader`; the Obsidian CLI is used only for everything else (creates, edits, daily notes, properties, listing tags). The semantic module can be disabled via `--no-semantic`; operations tools are always registered.
