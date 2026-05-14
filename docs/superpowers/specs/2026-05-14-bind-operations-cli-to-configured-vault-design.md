# Bind operations CLI to configured vault

**Status:** draft
**Date:** 2026-05-14
**Type:** bug fix (single-vault correctness)

## Problem

Write tools that go through the Obsidian CLI (`create_note`, `read_daily`, `set_property`, `remove_property`, etc.) ignore `--vault` (reported against v5.2.0; the call site has not changed since) and operate on whichever vault is currently active in the running Obsidian process. Reads via `FsVaultReader` are unaffected because they go to disk directly with a known `vaultRoot`.

Concrete symptom: with two vaults open in Obsidian (e.g. a personal sandbox + a wiki), launching the MCP with `--vault <sandbox>` correctly reads from sandbox, but `create_note` writes the file into the wiki vault — whichever was last active. Empty daily-note stubs created by `read_daily` have been observed in the wrong vault for the same reason.

## Diagnosis

`ObsidianCLIProvider` already supports a `vaultName` constructor option, and `buildArgs` (in `src/modules/operations/obsidian-cli-provider.ts`) already appends `vault=<name>` to each CLI invocation when that option is set. The bug is at the call site: `createOperationsModule` constructs the provider with only `binaryPath`:

```ts
// src/modules/operations/index.ts, line 40 (current)
const provider = providerFactory({ binaryPath: config.binaryPath });
```

`vaultName` is never passed, so `buildArgs` never appends the `vault=` token, and the obsidian-cli falls back to the currently active vault inside the running Obsidian instance.

## Scope

Single-vault correctness only. The MCP server still serves one vault per process; tool inputs do not gain a `vault` parameter; the parameter dictionary in `AGENTS.md` is not extended.

Out of scope:

- Multi-vault support (one server, many vaults, per-call `vault` argument).
- Replacing CLI-backed write tools with `FsVaultWriter`. `edit_note` already writes directly; the rest (`create_note`, `read_daily`, property tools) intentionally stay on the CLI because they depend on Obsidian-side behaviour (templates, daily-note logic, properties view sync).
- Reading Obsidian's vault registry (`~/Library/Application Support/obsidian/obsidian.json` and OS equivalents) to resolve the vault name. Rejected because the format is undocumented, paths differ per OS, and the basename heuristic already covers the typical case with zero I/O.

## Design

### Vault-name resolution

`vaultName = argv['vault-name'] ?? path.basename(normalizedVaultPath)`.

Decision happens once in `parseConfig`. By the time the value enters the rest of the system it is a plain required string — no consumer needs to know whether it came from a default or an override. The default (`basename`) is correct for the typical Obsidian setup where the display name in "Manage vaults" matches the directory name. The `--vault-name` flag exists as an explicit escape hatch for the case where the user renamed the vault in Obsidian's UI and the display name diverged from the directory.

### Data flow

```
parseConfig
   │  resolves vaultName (override or basename)
   ▼
ServerConfig.operations.vaultName: string  (required)
   │
   ▼
startNeuroVaultServer → createOperationsModule({ vaultPath, vaultName, binaryPath })
   │
   ▼
providerFactory({ binaryPath, vaultName })
   │
   ▼
ObsidianCLIProvider.buildArgs → always appends `vault=<name>`
```

### Interface changes

**CLI (`src/config.ts`):**

- New optional flag `--vault-name <name>`, type `string`. Help text: "Override the Obsidian vault name used in CLI invocations. Defaults to the basename of --vault. Set this only if you renamed the vault in Obsidian's 'Manage vaults' UI and the display name differs from the directory name."
- Validation: if provided, `value.trim()` must be non-empty; otherwise throw with a clear error.

**`ServerConfig` (`src/types.ts`):**

```ts
operations: {
  enabled: boolean;
  binaryPath?: string;
  vaultName: string;   // required, resolved
}
```

**`OperationsModuleConfig` (`src/modules/operations/index.ts`):**

```ts
export interface OperationsModuleConfig {
  vaultPath: string;
  vaultName: string; // required
  binaryPath?: string;
}
```

At line 40, change to:

```ts
const provider = providerFactory({
  binaryPath: config.binaryPath,
  vaultName: config.vaultName,
});
```

`ObsidianCLIProviderOptions.vaultName` stays optional at the provider level. The provider is unit-tested in isolation and should not encode "module-level required" semantics; the required contract lives one layer up in `OperationsModuleConfig`.

### Error handling

If the resolved `vaultName` does not match any vault known to the running Obsidian instance, obsidian-cli emits stderr like `vault not found: <name>`. Today this falls through to a generic `CLI_ERROR`, leaving the user without a path to recovery. Add a dedicated branch to `mapExecError` (in `src/modules/operations/obsidian-cli-provider.ts`):

```ts
if (/vault (not found|does not exist)/i.test(stderr)) {
  return new ToolHandlerError(
    'VAULT_NOT_FOUND',
    `Obsidian does not recognize a vault named '${this.vaultName}'. ` +
      `This usually means the vault was renamed in Obsidian's "Manage vaults" UI ` +
      `and the display name no longer matches the directory basename. ` +
      `Re-launch the server with --vault-name <exact-name-in-obsidian>.`,
    { details: { stderr, vaultName: this.vaultName }, cause: error },
  );
}
```

Ordering matters: this branch must run **before** the generic `/not found/i` branch, otherwise "vault not found" gets misclassified as `NOT_FOUND` (note not found).

A new `VAULT_NOT_FOUND` member is added to the `ToolHandlerErrorCode` union.

## Testing

**`test/config.test.ts`** (existing file):

- Default: `--vault /abs/path/MyVault` → `config.operations.vaultName === 'MyVault'`.
- Explicit override: `--vault /abs/path/MyVault --vault-name "Custom Name"` → `config.operations.vaultName === 'Custom Name'`.
- Validation: `--vault-name ""` (and whitespace-only) → throws.
- Trailing slash: `/abs/path/MyVault/` → basename still `'MyVault'`. This is `path.basename` behaviour after `path.resolve`, but locked in by test because the rest of the design depends on it.

**`test/operations/obsidian-cli-provider.test.ts`** (existing file):

- `vault=<name>` present in the args of every method that shells out: `createNote`, both subcommands of `readDaily`, `setProperty`, `readProperty`, `removeProperty`, `listProperties`, `listTags`. Done by passing a fake `exec` that captures args.
- `mapExecError`: stderr `vault not found: Foo` → `VAULT_NOT_FOUND` with the `--vault-name` hint. Verify branch ordering — the same stderr must not match the generic `NOT_FOUND` branch.

**Module wiring (existing or new operations-module integration test):**

- `createOperationsModule({ vaultPath, vaultName: 'X', binaryPath: undefined }, { vaultProviderFactory: spy })` → the spy receives `{ vaultName: 'X', binaryPath: undefined }`. Guarantees the value is not dropped en route.

Server-level wiring tests are intentionally skipped — once config → module is covered, the intermediate hop in `server.ts` is a straight pass-through.

## Documentation

- README: a short paragraph introducing `--vault-name`. Default behaviour stays implicit; the flag is described as an escape hatch for the renamed-vault edge case.
- `docs/architecture/vault-provider.md`: a paragraph noting that the CLI is bound to a vault name resolved at startup, and that this binding is what makes single-vault writes deterministic regardless of which vault Obsidian considers "active".

## Definition of Done

- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- README updated.
- `docs/architecture/vault-provider.md` updated.
- Conventional commit: `fix(operations): bind CLI invocations to the configured vault`.
- Patch version bump (`5.4.0 → 5.4.1`). Not a minor: no MCP parameter additions, the new CLI flag is optional with a sensible default, and behaviour for single-vault users on the typical path is unchanged.
- PR → `main` → `npm run release` on `main`.

## Why not multivault

The reported symptom looks like a missing feature ("multivault support") but is actually a correctness bug in the existing single-vault contract: the user already passed `--vault`, and the expectation that writes land there is reasonable. Fixing the binding closes the report without expanding the MCP surface. Real multivault — one server, per-tool `vault` argument, multi-vault smart-connections handling — is a separate, larger design and is left for a future spec if and when it has user demand beyond this one report.
