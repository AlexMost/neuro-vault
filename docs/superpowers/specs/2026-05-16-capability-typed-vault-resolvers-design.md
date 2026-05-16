# Capability-Typed Vault Resolvers

## Goal

Eliminate the 14 non-null assertions (`entry.writer!`, `entry.provider!`, `entry.corpus!`) that have accumulated across operations- and semantic-tool handlers, by making `IVaultEntry`'s fields honest about which invariants are runtime-conditional and adding a single capability-typed resolver for the one field that is.

The current shape is a typing lie: `writer` and `provider` are typed as optional but in practice always exist whenever an operations-tool handler runs (because operations tools are not registered when `--no-operations` is passed). Every handler is forced to assert through that lie with `!`. The same is _not_ true for `corpus` — semantic indexing can genuinely fail or be empty at runtime even with `--semantic` enabled — but the existing `resolveVault({ requireSemantic: true })` pattern still returns the optional-typed entry and forces a `corpus!` at the call site.

## Non-goals

- Re-thinking `--no-semantic`. It stays. Semantic loading has real startup cost (embedding model download, corpus parsing) so the user-facing knob is justified.
- Splitting `ObsidianCLIProvider`, fan-out partial-failure semantics, or migrating `lib/obsidian/*` to domain errors. Those are separate items from the same architectural review and will be addressed in their own specs.
- Adding new capabilities (per-vault read-only mode, etc.). YAGNI — the invariant we are codifying is the one that exists today.

## Architecture

### Remove `--operations` flag entirely

The `--operations` / `--no-operations` CLI flag is removed. Operations tools are always registered. Writer and provider are always constructed in `VaultRegistry.create()`. The justification: the flag costs nothing to remove (zero startup work in operations construction — they are pure-object factories) and its presence forces every consumer to type-guard a field that is, in practice, always present.

Consequence: a user who only wants semantic search will now see operations tools listed in `tools/list`. This is acceptable. Tool routing is the assistant's responsibility, not the server's — and a tool that fails with `CLI_NOT_FOUND` at call time is a more useful signal than a tool that does not exist.

### Make `writer` and `provider` required on `IVaultEntry`

```ts
// src/lib/vault-registry.ts — after
export interface IVaultEntry {
  name: string;
  path: string;
  smartEnvPath: string;
  reader: VaultReader;
  writer: VaultWriter; // was: writer?: VaultWriter
  provider: VaultProvider; // was: provider?: VaultProvider
  graph: WikilinkGraphIndex;
  listMatchingPaths: ListMatchingPaths;
  corpus?: SmartConnectionsCorpusIndex;
  semanticAvailable: boolean;
  semanticUnavailableReason?: string;
}
```

`corpus`, `semanticAvailable`, and `semanticUnavailableReason` stay optional / non-narrowed. Semantic readiness is a true runtime condition: even with `--semantic` enabled, the Smart Connections corpus can be missing, empty, or fail to parse.

### Add `resolveSemanticVault`

```ts
// src/lib/resolve-vault.ts — added
export function resolveSemanticVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: { tool: ToolName },
): IVaultEntry & { corpus: SmartConnectionsCorpusIndex } {
  const entry = resolveVault(input, registry, opts);
  if (!entry.semanticAvailable) {
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_NOT_FOUND',
      `Semantic index for vault "${entry.name}" is unavailable: ` +
        `${entry.semanticUnavailableReason ?? 'unknown reason'}`,
      {
        details: {
          vault: entry.name,
          hint: `open vault "${entry.name}" in Obsidian with Smart Connections installed`,
        },
      },
    );
  }
  // semanticAvailable === true implies corpus is defined (registry invariant).
  return entry as IVaultEntry & { corpus: SmartConnectionsCorpusIndex };
}
```

The `as` cast is safe because of a registry-side invariant: `VaultRegistry.create()` only sets `semanticAvailable: true` _after_ successfully constructing and snapshotting the corpus. The runtime check on `semanticAvailable` therefore implies `corpus !== undefined`; the cast bridges what TS cannot prove (the flag and field are independent declarations).

### Drop `requireSemantic` from `resolveVault`

```ts
// src/lib/resolve-vault.ts — after
export function resolveVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: { tool: ToolName },
): IVaultEntry {
  // unchanged body, but the `if (opts.requireSemantic && ...)` block is gone.
}
```

Call sites that used `{ requireSemantic: true }` now call `resolveSemanticVault` instead. Read-only callers (operations module's structural tools, e.g. `read_notes`, `query_notes`) keep calling `resolveVault`.

### No new resolver for writable tools

Operations tool handlers continue to call plain `resolveVault`. Because `writer` and `provider` are now required on `IVaultEntry`, the narrowing happens at the type-definition level — no per-handler narrowing function needed. This was the original temptation (`resolveWritableVault`) but is unnecessary once the underlying optionality is gone.

## Call-site changes

### Operations module (10 `!` removed)

| File                             | Before                                | After                                |
| -------------------------------- | ------------------------------------- | ------------------------------------ |
| `set-property.ts:52`             | `entry.provider!.setProperty(...)`    | `entry.provider.setProperty(...)`    |
| `remove-property.ts:46`          | `entry.provider!.removeProperty(...)` | `entry.provider.removeProperty(...)` |
| `list-tags.ts:22`                | `entry.provider!.listTags()`          | `entry.provider.listTags()`          |
| `list-properties.ts:22`          | `entry.provider!.listProperties()`    | `entry.provider.listProperties()`    |
| `read-property.ts:46`            | `entry.provider!.readProperty(...)`   | `entry.provider.readProperty(...)`   |
| `get-vault-overview.ts:24`       | `provider: entry.provider!`           | `provider: entry.provider`           |
| `read-daily.ts:51`               | `entry.provider!.readDaily()`         | `entry.provider.readDaily()`         |
| `edit-note.ts:67`                | `entry.writer!.replaceInNote(...)`    | `entry.writer.replaceInNote(...)`    |
| `edit-note.ts:73`                | `entry.writer!.replaceFullBody(...)`  | `entry.writer.replaceFullBody(...)`  |
| `resources/vault-overview.ts:29` | `provider: entry.provider!`           | `provider: entry.provider`           |

### Semantic module (4 `!` removed)

| File                       | Before                                                            | After                                         |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| `search-notes.ts:108`      | `resolveVault(..., { requireSemantic: true }); ... entry.corpus!` | `resolveSemanticVault(...); ... entry.corpus` |
| `get-similar-notes.ts:189` | same pattern                                                      | same fix                                      |
| `find-duplicates.ts:64`    | same pattern                                                      | same fix                                      |
| `get-stats.ts:62`          | same pattern                                                      | same fix                                      |

### Server wiring (`src/server.ts`)

- Remove the `if (!config.semantic.enabled && !config.operations.enabled)` early-fail at line 189 (operations is always enabled now).
- Remove `operationsEnabled: config.operations.enabled` from the `VaultRegistry.create` call at line 196.
- Remove the `if (config.operations.enabled)` gate at line 223 that registers operations module — operations module is always registered.

### Config (`src/config.ts`)

- Remove `.option('operations', ...)` from yargs.
- Remove the `operations` block from `ServerConfig`. The only field inside it that still has a consumer is `binaryPath`; it moves to top-level `config.obsidianCli` so the type matches the user-facing CLI surface (only `--obsidian-cli` remains).
- Remove the `--semantic` / `--operations` mutual-exclusion check.

### Registry config (`src/lib/vault-registry.ts`)

```ts
// IVaultRegistryConfig — after
export interface IVaultRegistryConfig {
  vaults: IVaultConfig[];
  semanticEnabled: boolean; // unchanged
  modelKey: string;
  binaryPath?: string;
  // removed: operationsEnabled
}
```

Writer and provider are unconditionally constructed in `VaultRegistry.create()`:

```ts
const writer = deps.writerFactory({ vaultRoot: v.path });
const provider = deps.providerFactory({ vaultName: v.name, binaryPath: config.binaryPath });
```

## Error handling

No new error codes. Existing codes keep their semantics:

- `SEMANTIC_INDEX_NOT_FOUND` — moved from `resolveVault`'s `requireSemantic` branch into `resolveSemanticVault`'s body. Message and details payload preserved verbatim.
- `CLI_NOT_FOUND` / `CLI_UNAVAILABLE` — Obsidian CLI absence is detected per-call by `ObsidianCLIProvider.mapExecError`, unchanged. A user without Obsidian who previously avoided operations via `--no-operations` will now see operations tools registered but failing at call time. The error message and code stay the same; the user-visible difference is the surface, not the experience.
- `VAULT_REQUIRED`, `VAULT_NOT_FOUND` — unchanged.

## Testing strategy

### Unit / contract tests

- Update `test/lib/resolve-vault.test.ts`: drop tests covering the `requireSemantic` option; add tests for `resolveSemanticVault` covering: single-vault happy path, multi-vault with `vault:` selection, missing `semanticAvailable` throws `SEMANTIC_INDEX_NOT_FOUND`, narrowed return type covers `corpus` (compile-time check via a `satisfies` assertion).
- Update `test/lib/vault-registry.test.ts`: drop `operationsEnabled: true/false` from all test cases (the field is gone). Assert that `entry.writer` and `entry.provider` are non-null on every entry returned by `create()`.
- Per-tool tests (`test/operations/tools/*.test.ts`, `test/semantic/tools/*.test.ts`): drop the `!` non-null assertions from any test that builds its own entry mock. Update `test/operations/tools/_test-registry.ts` helper accordingly so mocked entries unconditionally carry `writer` and `provider`.

### Integration tests

- `test/server-modules.test.ts:77` — the test `--no-operations is honored` becomes invalid. Delete it.
- `test/server-modules.test.ts:318` — the test exercising `--no-semantic --no-operations` becomes invalid (the combination is now an unknown CLI option, since `--operations` is gone). Delete it.
- `test/config.test.ts:126` — the parser test for `--no-operations --no-semantic` becomes invalid. Replace with a test that asserts `parseConfig(['--vault', vaultPath, '--no-semantic'])` succeeds (semantic-only mode is still valid).
- Add a new test in `test/config.test.ts` confirming that passing `--no-operations` results in a yargs `strict()` rejection (unknown option) — this is the user-facing migration error and we want it to be clean.

### Type-level smoke

A short test file (or assertion inside an existing one) that uses `satisfies` to confirm `IVaultEntry['writer']` and `IVaultEntry['provider']` are not optional:

```ts
type AssertRequired<T, K extends keyof T> = undefined extends T[K] ? never : true;

const _writerIsRequired: AssertRequired<IVaultEntry, 'writer'> = true;
const _providerIsRequired: AssertRequired<IVaultEntry, 'provider'> = true;
```

## Migration / release

This is a breaking change at the CLI surface — `--operations` and `--no-operations` are removed. Bump to **7.0.0**.

CHANGELOG note (auto-generated by `commit-and-tag-version` from the Conventional Commit; the breaking-change footer carries the migration hint):

```
feat(config)!: remove --operations / --no-operations CLI flag

BREAKING CHANGE: The --operations and --no-operations flags are removed.
Operations tools (create_note, edit_note, read_daily, properties, tags,
read_notes, query_notes) are now always registered. Users who previously
ran with --no-operations should drop the flag — agents will route around
unavailable tools per the existing CLI_NOT_FOUND / CLI_UNAVAILABLE errors.
The --semantic / --no-semantic flag is unchanged.
```

## Documentation

- `docs/guide/configuration.md` — remove the `--operations` row from the CLI-arguments table; remove the `--no-operations` mention from the `CLI_NOT_FOUND` troubleshooting bullet.
- `docs/guide/installation.md` — remove the `--no-operations` mention in the Obsidian-CLI-optional bullet.
- `docs/guide/vault-operations.md` — remove the `Pass --no-operations to disable all operations tools` sentence from the lead-in.
- `docs/architecture/module-structure.md` — rewrite the bullet about `--no-semantic` / `--no-operations` to reflect that only semantic remains opt-out.
- `README.md` — quick scan for `--no-operations`; remove if present.

## Definition of Done

A change is complete when every item below is true:

- The `--operations` and `--no-operations` flags are not accepted by `parseConfig`; passing either fails fast via yargs `strict()` with a clear unknown-option error.
- `IVaultEntry.writer` and `IVaultEntry.provider` are required (no `?`); `IVaultEntry.corpus` is unchanged (still optional).
- Every `entry.writer!`, `entry.provider!`, `entry.corpus!` non-null assertion in `src/modules/` is removed; `grep -rn "entry\.\(writer\|provider\|corpus\)!" src/` returns nothing.
- `resolveSemanticVault` exists in `src/lib/resolve-vault.ts` and is used by all four semantic tools (`search-notes`, `get-similar-notes`, `find-duplicates`, `get-stats`).
- `resolveVault` no longer accepts a `requireSemantic` option.
- `npm test` passes; `npm run lint` clean; `npx tsc --noEmit` clean.
- Docs in `docs/guide/` and `docs/architecture/` no longer mention `--no-operations` (only the CHANGELOG and historical specs may retain it).
- A type-level assertion (`AssertRequired<IVaultEntry, 'writer'>`) compiles, locking the invariant against future regressions.
- Version bumped to 7.0.0 by `npm run release` on `main` after the PR merges.
