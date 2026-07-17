## Why

Bro v0 deploys neuro-vault on a headless VPS, where six vault-operation tools (`create_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, `list_properties`) and the tags/properties sections of `get_vault_overview` are dead: they route through `ObsidianCLIProvider`, which needs the `obsidian` CLI binary and a running Obsidian app. The Hermes config depends on `create_note` (URL → task capture) and `read_daily` (session priming), so the deploy is blocked. Migrating the provider to direct disk access unblocks headless operation and removes the server's last runtime dependency on a GUI application.

## What Changes

**Vault-operation provider**

- From: `IVaultEntry.provider` is `ObsidianCLIProvider`; every provider-backed tool requires the `obsidian` binary and a running Obsidian instance.
- To: `IVaultEntry.provider` is `FsVaultProvider`, which constructs an `ObsidianCLIProvider` internally and delegates not-yet-migrated methods to it (strangler fig). Each subsequent step flips one method group to a disk-direct implementation; when no delegations remain, `ObsidianCLIProvider` is deleted.
- Reason: zero-regression migration — no config flag, no stub window; laptop behavior is unchanged until a method migrates, and on a VPS unmigrated methods keep failing with `CLI_NOT_FOUND` exactly as today.
- Impact: non-breaking during migration. The final removal step is breaking at the config surface (see below).

**Method migrations (each its own task)**

- `listTags` / `listProperties`: aggregation over the existing `query_notes` scan infrastructure. Counts frontmatter tags only — the CLI also counted inline `#tags` in bodies, so counts can diverge (accepted).
- `readDaily`: resolve today's note from `.obsidian/daily-notes.json` (folder + format) via the existing `daily-notes-config.ts`; error `DAILY_NOTES_NOT_CONFIGURED` behavior must match the current tool contract.
- `createNote` / `setProperty` / `removeProperty`: direct file writes and YAML frontmatter rewrites. Templates are a non-loss (content arrives fully formed from the caller). `setProperty` no longer registers new property types in Obsidian's `types.json` (accepted; documented).

**Final removal (breaking)**

- From: `--obsidian-cli` config option; `CLI_NOT_FOUND` / `CLI_UNAVAILABLE` / `CLI_TIMEOUT` error codes; "CLI availability" section in server instructions.
- To: all removed together with `obsidian-cli-provider.ts`.
- Reason: dead code once no method delegates.
- Impact: breaking — yargs `strict()` makes existing launch commands passing `--obsidian-cli` fail to start. Ship as a major version.

## Capabilities

### New Capabilities

- `headless-vault-operations`: every vault-operation tool works from disk alone — no Obsidian CLI binary, no running Obsidian app. Covers the provider delegation semantics during migration, the disk-direct behavior of each migrated method (including accepted divergences from the CLI: frontmatter-only tag counts, no `types.json` registration), and the end-state removal of the CLI path.

### Modified Capabilities

<!-- none — no existing spec's requirements change; the tool surface is untouched (mcp-tool-surface) and baseline invariants (ToolHandlerError, execFile-only external processes) continue to hold -->

## Impact

- **Code**: new `src/modules/operations/fs-vault-provider.ts`; wiring swap in `src/server.ts` (`buildDefaultVaultEntryDeps`); `reader`/`writer` threaded into `providerFactory` opts (`src/lib/vault-registry.ts`) by the first method that needs them; eventually delete `src/modules/operations/obsidian-cli-provider.ts` and the `--obsidian-cli` option in `src/config.ts`.
- **Server instructions**: the "CLI availability" section (`src/server.ts`) is rewritten at the final step; it is already stale today (understates the disk-direct tool set).
- **Docs**: ADR-0007 ("vault writes go through obsidian-cli") is superseded — mint a new ADR at the final step; update `docs/architecture/` provider notes.
- **Release**: intermediate steps are regular minor/patch releases; the final removal is a major version.
- **External**: planning notes in the user's vault (`Tasks/neuro-vault/FsVaultProvider.md` + three leg notes) mirror this change 1:1.
