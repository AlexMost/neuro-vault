## Context

`IVaultEntry.provider` (the `VaultProvider` interface, `src/lib/obsidian/vault-provider.ts`, 6 methods) is implemented only by `ObsidianCLIProvider`, which shells out to the `obsidian` CLI via `execFile` and therefore needs both the binary and a running Obsidian app. Provider-backed tools: `create_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, `list_properties`, plus the tags/properties sections of `get_vault_overview` (`vault-overview.ts:47` — an uncaught `Promise.all` over `provider.listTags()` / `provider.listProperties()`, so a throwing provider kills the whole overview tool).

The rest of the operations module is already disk-direct: `read_notes`, `query_notes` (scan + frontmatter/tag extraction), `edit_note` (`FsVaultWriter`), `get_note_links` (wikilink graph), lexical `search_notes`. Reusable assets: `daily-notes-config.ts` (parses `.obsidian/daily-notes.json`), the `query_notes` scan extractors, `FsVaultReader`/`FsVaultWriter` (constructed in `VaultRegistry.create` *before* the provider).

Constraint from the vault-side plan: Bro v0 needs `create_note` and `read_daily` working on a headless VPS. Stakeholders: the laptop setup (Obsidian running, CLI available — must not regress mid-migration) and the VPS setup (no Obsidian at all).

## Goals / Non-Goals

**Goals:**

- Every `VaultProvider` method works from disk alone; the server is fully functional with no `obsidian` binary and no running Obsidian.
- Zero regression window: at every intermediate commit, laptop behavior is unchanged for unmigrated methods and `get_vault_overview` keeps working.
- End state deletes `ObsidianCLIProvider` and every artifact that exists only to serve it (error codes, config flag, instructions section).

**Non-Goals:**

- No config surface for provider selection (`--vault-provider` was considered and rejected — see D1).
- No changes to tool input/output schemas or the MCP parameter dictionary.
- No re-implementation of Obsidian conveniences: note templates (content arrives fully formed) and `types.json` property-type registration are deliberately dropped.
- No changes to the semantic module.

## Decisions

### D1: No provider-selection config; one provider path

- **Choice**: `FsVaultProvider` becomes the only wired provider; migration happens per-method inside it.
- **Rationale**: a `--vault-provider fs|cli` flag doubles the test matrix, needs conditional server instructions, invites contradictory-flag handling (`--obsidian-cli` + fs), and raises "what does a mid-migration release ship" questions. One path with internal delegation has none of these.
- **Alternative considered**: explicit `--vault-provider fs|cli` flag, no auto-fallback (the original vault-note plan). Rejected as pure surface area with no lasting benefit.

### D2: Strangler fig via internal delegation, not stubs

- **Choice**: `FsVaultProvider` constructs an `ObsidianCLIProvider` in its own constructor and calls it from every method that lacks a disk implementation. Each migration flips one method group; the delegate field disappears with the last one.
- **Rationale**: `NOT_IMPLEMENTED` stubs would break `get_vault_overview` outright during the window (uncaught `Promise.all`) and add a transient error code to the dictionary. Delegation keeps behavior bit-for-bit identical until a method actually migrates.
- **Alternative considered**: skeleton with `NOT_IMPLEMENTED` throws (original plan) — rejected for the overview breakage and the stub window. Injected delegate (`{ delegate }` option wired in `server.ts`) — rejected as leaking the migration mechanism into wiring; internal construction keeps `providerFactory`'s signature untouched and the eventual deletion contained in one file.

### D3: `FsVaultProvider` accepts `ObsidianCLIProviderOptions` wholesale

- **Choice**: the constructor takes the same options bag (`vaultName`, `vaultRoot`, `binaryPath`, `timeoutMs`, `exec`, `stat`) and forwards it to the internal CLI provider.
- **Rationale**: `server.ts` wiring changes by one class name; the existing `exec`/`stat` injection remains the test seam, so delegation tests assert on CLI invocations exactly like today's provider tests.

### D4: `reader`/`writer` join `providerFactory` opts lazily

- **Choice**: the skeleton does not thread `FsVaultReader`/`FsVaultWriter` into the factory; the first migrated method that needs them adds them to `IVaultEntryDeps.providerFactory` opts.
- **Rationale**: both are already constructed before the provider in `VaultRegistry.create`, so threading is a few lines whenever needed; the skeleton carries no dead fields (and trips no unused-member lint).
- **Alternative considered**: pre-threading in the skeleton — rejected as speculative.

### D5: Disk implementations reuse existing infrastructure

- **Choice**: `listTags`/`listProperties` aggregate `{ name, count }` over the `query_notes` scan extractors; `readDaily` resolves today's path via `daily-notes-config.ts` and reads via `FsVaultReader`; `createNote`/`setProperty`/`removeProperty` write via `FsVaultWriter` and the existing frontmatter parse/serialize helpers.
- **Rationale**: every building block already exists and is tested; the legs are wiring plus edge-case semantics, not new subsystems.

### D6: Error-code parity per method, not per provider

- **Choice**: each migrated method keeps its tool-contract error codes (`NOTE_EXISTS`, `DAILY_NOTES_NOT_CONFIGURED`, `NOT_FOUND`, …) but stops producing `CLI_*` codes; the `CLI_*` family dies with the final deletion.
- **Rationale**: clients branch on semantic codes, which are provider-independent; `CLI_*` codes describe transport failure of a transport being removed.

## Risks / Trade-offs

- [Risk] YAML frontmatter rewrite (`setProperty`/`removeProperty`) corrupts formatting the CLI used to preserve → Mitigation: reuse the same frontmatter helpers `edit_note` already trusts (`in-place-edit.ts` preserves frontmatter byte-for-byte today); property-edit round-trip tests over representative fixture notes.
- [Risk] `readDaily` semantics drift from the CLI (`daily:read`) around a missing daily note → Mitigation: the tool contract already tells agents to `create_note` when the daily doesn't exist; pin the current `DAILY_NOTES_NOT_CONFIGURED` behavior in the delta spec and test both paths.
- [Trade-off] `listTags` counts frontmatter tags only; the CLI also counted inline `#tags` in bodies → Accepted: `query_notes` already defines `tags` as frontmatter-only for the whole server; the counts converging on that definition is a consistency win, and the divergence is documented in the spec.
- [Trade-off] `setProperty` no longer registers new property types in `.obsidian/types.json` → Accepted: affects only Obsidian's Properties UI rendering for brand-new keys; values themselves are written correctly.
- [Trade-off] `createNote` no longer applies Obsidian templates → Accepted: callers pass fully-formed content (the CLI path's templating was unused by the flows this serves).
- [Risk] Final removal breaks launch commands passing `--obsidian-cli` (yargs `strict()`) → Mitigation: ship the removal as a major version with a changelog migration note.

## Migration Plan

Each step is independently releasable; order of 2–4 is a delivery choice (2 first revives `get_vault_overview` headless cheapest; 3–4 are what Bro v0 actually needs).

1. **Skeleton**: `FsVaultProvider` delegating all 6 methods; one-word wiring swap in `buildDefaultVaultEntryDeps`. Pure refactor, no observable change.
2. **Scan leg**: `listTags` + `listProperties` from the scan extractors (unblocks headless `get_vault_overview`).
3. **Daily leg**: `readDaily` from `daily-notes.json`.
4. **Write leg**: `createNote`, `setProperty`, `removeProperty` via `FsVaultWriter`.
5. **Removal (major)**: delete `obsidian-cli-provider.ts`, the internal delegate field, `--obsidian-cli` in `config.ts`, `CLI_*` error mapping, and rewrite the "CLI availability" server-instructions section; supersede ADR-0007 with a new ADR; update `docs/architecture/`.

Rollback: any step is a plain `git revert` — no data migrations, no persisted state. Until step 5 ships, reverting a leg silently returns that method to CLI delegation.

Acceptance: `npm test && npm run lint && npm run typecheck` green at every step; after step 4, a manual smoke run of the server on a machine (or env) without the `obsidian` binary exercising `create_note`, `read_daily`, `list_tags`, `get_vault_overview`.

## Open Questions

- Does `read_daily`'s `notes_today` section route through the provider or the scan? (Believed scan-based — verify during the daily leg; if it touches the provider, it joins the leg's scope.)
- Exact `createNote` collision semantics on disk (`NOTE_EXISTS` parity with the CLI's "already exists" mapping) — pin down in the write leg's tests.
