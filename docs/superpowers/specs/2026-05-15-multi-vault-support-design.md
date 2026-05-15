# Multi-vault support

**Status:** approved
**Date:** 2026-05-15
**Type:** feature (breaking — v6.0.0)
**Source:** [[Tasks/Multi-vault підтримка в neuro-vault MCP]] (Darwin RFC, 2026-05-15)

## Problem

`neuro-vault-mcp` is single-vault per process. One `--vault` argument, one in-memory index, one Smart Connections root, one Obsidian-CLI vault name. Users with N vaults (personal + team wiki + per-project) work around this by launching N parallel MCP instances. That works but costs:

- N × M tools clutter the client's tool surface.
- The LLM caller has to pick the right server per request — no merged search.
- Config grows linearly per vault.
- No path to cross-vault semantic similarity.

Concrete case: personal sandbox + DMARKOFF wiki on a separate Drive account. Today the wiki is effectively invisible to semantic search because the second MCP instance doubles the tool surface and offers no merged search.

## Goal

One `neuro-vault-mcp` process serves N registered vaults. Tool inputs grow an optional `vault: string` parameter. `search_notes`, `query_notes`, and `get_vault_overview` fan out across all registered vaults when `vault:` is omitted. Other tools require an explicit `vault:` in multi-mode. Result shape always carries `vault:`, in single-mode and multi-mode alike — one shape, one code path.

## Non-goals

- **Cross-vault `get_similar_notes`.** The seed note lives in one vault and embedding models are per-vault — "similar across vaults" is semantically suspect. `vault:` is required for the seed in multi-mode; results are flat from that vault only.
- **Cross-vault score merging.** `results_by_vault` is a grouped list, never one ranked stream. Per-vault embedding models make cosine scores non-comparable.
- **`--default-vault` flag.** Third branch with zero value over the chosen rules (fan-out where it makes sense, `VAULT_REQUIRED` otherwise).
- **Reading Obsidian's vault registry** (`obsidian.json`) to resolve vault names. The `name` token in `--vault name:path` doubles as both the MCP identifier and the obsidian-cli `vault=` token; that covers the typical case with zero I/O.
- **Per-vault Obsidian display-name overrides.** If a user's Obsidian display name diverges from the chosen MCP identifier they can either rename in Obsidian's "Manage vaults" UI or pick a name that matches. If this bites in the wild we can add a triplet syntax (`--vault mcp-name:path:obsidian-name`) later without breaking the v6 contract.
- **Migration shims / dual code paths.** Clean break to v6.0.0; the existing `--vault-name` flag is removed.

## CLI

`--vault` becomes repeatable with an optional `name:` prefix:

```
neuro-vault-mcp \
  --vault personal:/path/to/sandbox \
  --vault dmarkoff:/path/to/wiki
```

Without a prefix, `name = path.basename(value)`:

```
neuro-vault-mcp --vault /path/to/sandbox
# → registers a single vault with name "sandbox"
```

This is the single-vault invocation. The CLI surface is identical to v5.x for the one-vault case; only the result shape changes (see below).

**Parser rules:**

- Syntax: `<name>:<absolute-path>` or `<absolute-path>`. Discrimination by leading `/` (POSIX absolute paths are unambiguous; the colon is unreserved in absolute paths and the parser cuts at the first one when the value does not start with `/`).
- `name` must match `^[a-zA-Z0-9_-]{1,64}$`. Anything else → fail-fast at startup with `INVALID_ARGUMENT`-style error.
- `path` must be absolute and resolve to an existing directory; otherwise fail-fast.
- Vault names must be unique across all `--vault` flags; duplicates fail-fast.
- At least one `--vault` flag is required; zero vaults fails-fast.

**Removed flag:** `--vault-name`. The bind-operations escape hatch is now folded into the `name:` prefix. Migration is a single-line CLI rewrite covered in the v6.0.0 CHANGELOG.

## ServerConfig

```ts
export interface VaultConfig {
  name: string;
  path: string; // absolute, normalized
  smartEnvPath: string; // <path>/.smart-env/multi
}

export interface ServerConfig {
  vaults: VaultConfig[]; // length >= 1, names unique
  semantic: {
    enabled: boolean;
    modelKey: string;
    modelId: string;
  };
  operations: {
    enabled: boolean;
    binaryPath?: string;
  };
}
```

`semantic.smartEnvPath` and `operations.vaultName` move into `VaultConfig`. Module-level config keeps only what is genuinely cross-vault (model selection, binary path).

The `vaults.length === 1` case is detectable at runtime — used for resource URI shape (see Resources below) and for skipping fan-out validation. Everything else treats the array uniformly.

## Vault registry

A new layer between `ServerConfig` and the modules.

```
src/lib/vault-registry.ts
  ├── VaultEntry { name, path, reader, writer?, provider?, graph,
  │                listMatchingPaths, corpus?, semanticAvailable: bool,
  │                semanticUnavailableReason?: string }
  └── VaultRegistry
        ├── get(name): VaultEntry | undefined
        ├── require(name): VaultEntry        // throws VAULT_NOT_FOUND
        ├── list(): VaultEntry[]
        ├── isMulti(): boolean
        └── semanticEnabledEntries(): VaultEntry[]
```

`createVaultRegistry(config, deps)` builds per-vault primitives once at startup:

- One `FsVaultReader` per vault (`vaultRoot = vault.path`).
- One `WikilinkGraphIndex` + `ListMatchingPaths` per vault (lazy refresh via existing `ensureFresh`).
- One `FsVaultWriter` per vault when `operations.enabled`.
- One `ObsidianCLIProvider` per vault when `operations.enabled`, bound to that vault's name (the same `vault=<name>` token the bind-operations fix introduced).
- One `SmartConnectionsCorpusIndex` per vault when `semantic.enabled` AND the vault has a readable `.smart-env/multi/` directory. If the directory is missing or the initial snapshot is empty, the entry is registered with `semanticAvailable: false` and a reason string; startup does **not** fail.

The embedding service is a single instance shared across all vaults — the model is identical and warm-up should not pay N times.

## Tool API

Every tool gains an optional `vault: string` parameter in its input schema. Behavior:

| Tool                                                                                                                              | `vault:` omitted (multi-mode)   | `vault:` present |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------- |
| `search_notes`, `query_notes`, `get_vault_overview`                                                                               | **Fan-out** across all vaults   | Single-vault op  |
| `get_similar_notes`, `find_duplicates`, `get_stats`, `read_notes`, `read_daily`, `get_note_links`, `list_tags`, `list_properties` | `VAULT_REQUIRED` error          | Single-vault op  |
| `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`                                                    | `VAULT_REQUIRED` error (writes) | Single-vault op  |

In single-vault mode (`vaults.length === 1`), `vault:` is optional everywhere and defaults to the sole registered vault. Passing a `vault:` that does not match registry name → `VAULT_NOT_FOUND` (in both single- and multi-mode).

Path-shaped parameters (`path`, `paths`, `path_prefix`) remain vault-relative. Vault identity is carried by `vault:`, never embedded in path strings.

## Result shapes

### Flat (single-vault op, explicit or implicit)

Every result item carries `vault: string`. Always. In single-vault mode too — one shape, one code path.

```jsonc
// search_notes — single result item
{
  "vault": "personal",
  "path": "10 Plans/Plan - X.md",
  "score": 0.79,
  "backlink_count": 3,
}
```

Top-level response shape is otherwise unchanged from v5.x.

### Fan-out (multi-mode, `vault:` omitted)

```jsonc
// search_notes fan-out
{
  "results_by_vault": [
    {
      "vault": "personal",
      "results": [
        { "vault": "personal", "path": "10 Plans/Plan - X.md", "score": 0.79, "backlink_count": 3 },
      ],
      "blockResults": [
        /* same per-result shape as single-vault */
      ],
      "truncated": false,
    },
    {
      "vault": "dmarkoff",
      "results": [
        {
          "vault": "dmarkoff",
          "path": "wiki/14 - Brand Guidelines.md",
          "score": 0.83,
          "backlink_count": 1,
        },
      ],
    },
  ],
  "skipped_vaults": [{ "vault": "team", "reason": "SEMANTIC_INDEX_NOT_FOUND" }],
}
```

The per-result `vault:` is redundant inside `results_by_vault[i].results` but kept for shape consistency — callers parsing flat output should not need a different mental model for fan-out output.

`skipped_vaults` is always present (possibly empty). It lists vaults that the fan-out logically tried but skipped, with a structured reason. Today the only documented reason is `SEMANTIC_INDEX_NOT_FOUND`; the format leaves room for future ones without a shape change.

### Per-tool fan-out details

- **`search_notes` / `get_similar_notes`** — `search_notes` fans out; `get_similar_notes` requires `vault:` (see Non-goals). Vaults without `.smart-env/` are skipped silently with `skipped_vaults`.
- **`query_notes`** — fans out. No `.smart-env/` dependency (reads from disk), so `skipped_vaults` is always empty for this tool. Each per-vault group keeps the existing `{ results, count, truncated }` shape, plus the outer `vault:` group key.
- **`get_vault_overview`** — fans out. The returned overview is per-vault (top folders, tags, properties, total count, top-linked notes for that vault). No cross-vault aggregation; the per-vault data is what callers need for orientation.
- **`find_duplicates` / `get_stats`** — require `vault:`. Both are per-vault diagnostics; fan-out has unclear semantics (duplicates across vaults? sum of stats?) and no requested use-case.

## Error codes

Existing structured errors are augmented with two new codes:

- **`VAULT_REQUIRED`** — multi-mode, `vault:` omitted on a tool that does not fan out. `details: { tool: string, registered_vaults: string[] }`.
- **`VAULT_NOT_FOUND`** — `vault:` value does not match a registered vault. `details: { requested: string, registered_vaults: string[] }`. (This code already exists for the obsidian-cli "active vault mismatch" case; the new use shadows it before any CLI call is made.)
- **`SEMANTIC_INDEX_NOT_FOUND`** — explicit `vault:` on a semantic tool, but that vault has no readable `.smart-env/multi/`. `details: { vault: string, hint: "open vault '<name>' in Obsidian with Smart Connections installed" }`. In fan-out the same condition triggers a silent skip with this code as the `reason` in `skipped_vaults`.

All three flow through the existing `ToolHandlerError` envelope.

## Resources

`vault://overview` is the only resource exported today. URI scheme depends on cardinality:

- **Single-vault mode** — `vault://overview` (unchanged).
- **Multi-vault mode** — `vault://<vault-name>/overview`, one resource per registered vault, registered at startup.

Asymmetry is deliberate: resource URIs are client wiring (some MCP clients auto-load resources by URI on connect), not data shape. Forcing single-vault users into `vault://sandbox/overview` would break that wiring with no benefit. The data shape rule ("vault always in payload") is independent.

## Server instructions

`buildServerInstructions` extends with a section explaining multi-vault semantics when `vaults.length > 1`:

- List registered vault names.
- Explain when to pass `vault:` (writes, reads of specific paths, vault-scoped semantic) and when to omit (broad search, query, overview).
- Note that path-shaped parameters are vault-relative; vault identity is always in `vault:`.

The existing static instructions block stays. The multi-vault section is conditional; single-vault startup serves the v5.x instructions unchanged.

The per-vault `.neuro-vault/for-external-agents.md` file continues to work — its content is loaded per vault and concatenated under a labelled subsection in multi-mode (`## Vault-specific conventions — <name>`). In single-mode the v5.x behavior (one unlabelled section) is preserved.

## Architecture impact

```
parseConfig(argv) → ServerConfig { vaults: VaultConfig[] }
   │
   ▼
createVaultRegistry(config, deps)
   │  builds per-vault primitives, attempts semantic load per vault
   ▼
VaultRegistry
   │
   ▼
startNeuroVaultServer
   │
   ├─ createSemanticModule(registry, sharedEmbeddingService)
   │     → tools that resolve `vault:` → entry.corpus / entry.graph / ...
   │
   └─ createOperationsModule(registry)
         → tools that resolve `vault:` → entry.reader / entry.writer / entry.provider
```

Module factories no longer build per-vault primitives directly; they consume the registry. Tool handlers gain a `resolveVault(input)` helper that returns the `VaultEntry` (or throws `VAULT_REQUIRED` / `VAULT_NOT_FOUND`). Fan-out helpers (`runFanOut`, `runSemanticFanOut`) live in a shared library so each fan-out tool stays focused on its own logic.

New architecture doc: `docs/architecture/vault-registry.md`. Updated docs: `docs/architecture/module-structure.md` (registry layer), `docs/architecture/vault-provider.md` (per-vault binding), `docs/architecture/smart-connections-corpus.md` (per-vault loading, missing-index tolerance), `docs/architecture/mcp-server-shape.md` (instructions block, resource URIs).

## Testing strategy

- **Parser unit tests** — `--vault name:path`, `--vault /path`, mixed flags, duplicate names, invalid names, missing path, no vaults at all.
- **Registry unit tests** — entry construction, `require` throws `VAULT_NOT_FOUND`, semantic unavailability is recorded (not thrown) when `.smart-env/` is missing, single-vault detection.
- **Per-tool tests** — for each tool: (a) single-vault registry resolves implicit `vault:`; (b) multi-vault registry with explicit `vault:` routes to the correct entry; (c) multi-vault registry without `vault:` either fans out (the four tools above) or throws `VAULT_REQUIRED`.
- **Fan-out integration tests** — `search_notes` across two vaults: both have `.smart-env/`, one is missing, both are missing, one yields zero results.
- **Result-shape tests** — `vault:` field present in every flat-result item in single-vault mode (regression guard for the "one shape" rule).
- **End-to-end smoke** — `npm run inspect` with two `--vault` flags loads, lists tools, and serves one fan-out call. (Manual, recorded in PR description, not in CI.)

Existing tests are migrated, not deleted. Most single-vault tests stay valid after adapting fixtures to wrap config in `{ vaults: [...] }`; the per-result `vault:` field is added to expected outputs en masse.

## Migration (CHANGELOG entry, v6.0.0)

- Single-vault users: `--vault /path` continues to work. Tool outputs now always include a `vault: string` field on every flat result item; clients that parse output structurally must accept it.
- Two-server users (the current workaround): replace two MCP registrations with one. Use `--vault name:path` per vault. Tool names change from `mcp__neuro-vault-foo__*` / `mcp__neuro-vault-bar__*` to `mcp__neuro-vault__*` with a `vault:` parameter on each call.
- The `--vault-name` flag is removed. Users who relied on it (Obsidian display name ≠ directory basename) should switch to `--vault <obsidian-name>:<path>`, which now carries both the MCP identifier and the obsidian-cli vault token.

## Implementation phases

Both phases ship under v6.0.0. The split is purely for ordering within the implementation plan; there is no intermediate release.

**Phase 1 — single-vault op with required `vault:`:**

- `--vault name:path` parser, ServerConfig.vaults, registry.
- `vault:` parameter on every tool input schema.
- `resolveVault(input)` helper; per-tool routing.
- `vault:` field on every flat result item.
- `VAULT_REQUIRED` for non-fan-out tools when `vault:` is omitted in multi-mode.
- `SEMANTIC_INDEX_NOT_FOUND` for explicit `vault:` against a vault with no `.smart-env/`.
- Server instructions updated; resources namespaced per cardinality.
- `--vault-name` flag removed.

**Phase 2 — fan-out:**

- `search_notes`, `query_notes`, `get_vault_overview` fan out when `vault:` omitted.
- `results_by_vault` shape; `skipped_vaults` envelope.
- Silent skip for vaults missing `.smart-env/` in `search_notes` fan-out.

If Phase 2 slips, Phase 1 can ship as v6.0.0 and Phase 2 as v6.1.0 (additive). Default plan: ship both together.

## Definition of Done

- `--vault` accepts repeated `name:path` flags; bare `--vault /path` works as a single-vault sensible default.
- Name uniqueness, name charset, and absolute-path checks validated at startup.
- `VaultRegistry` constructs per-vault primitives once; semantic unavailability is recorded, not thrown.
- Every tool input schema includes optional `vault: string`.
- Single-vault mode: `vault:` optional; defaults to the sole registered vault.
- Multi-vault mode: `vault:` required for all tools except `search_notes`, `query_notes`, `get_vault_overview` (which fan out).
- Multi-vault writes without `vault:` → `VAULT_REQUIRED`.
- Semantic tools against a vault with no `.smart-env/` → `SEMANTIC_INDEX_NOT_FOUND` (explicit) or silent skip + `skipped_vaults` entry (fan-out).
- Every flat result item carries `vault:` (single- and multi-mode).
- Fan-out tools return `results_by_vault` + `skipped_vaults`; no cross-vault score merge.
- `vault://overview` resource: single URI in single-mode, namespaced URI per vault in multi-mode.
- Server instructions extend with a multi-vault section when `vaults.length > 1`.
- Per-vault `.neuro-vault/for-external-agents.md` loads correctly in both modes.
- `--vault-name` flag is removed; CHANGELOG documents the migration.
- `npm test`, `npm run lint`, `npx tsc --noEmit` — green.
- `docs/architecture/vault-registry.md` exists; `module-structure.md`, `vault-provider.md`, `smart-connections-corpus.md`, `mcp-server-shape.md` updated.
- README documents multi-vault mode with a DMARKOFF wiki example.
- Conventional commit `feat(server)!: multi-vault support` (with `!` marker); PR → main → release v6.0.0.

## Open questions

(All closed as of 2026-05-15. Add here if new questions surface during implementation.)

## Connections

- [[Tasks/Multi-vault підтримка в neuro-vault MCP]] — source RFC from Darwin
- [[Tasks/Bind operations CLI to configured vault]] — single-vault prerequisite (already implemented); the `vault=<name>` CLI token introduced there is reused per-entry here, just bound at the registry layer rather than the module config
- [[Resources/neuro-vault — roadmap]] — should reflect v6.0.0 as a deliberate breaking release
- [[Projects/neuro-vault]] — project description; needs an update when v6 ships
