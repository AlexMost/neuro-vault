## 1. Skeleton — FsVaultProvider with internal delegation

- [x] 1.1 Create `src/modules/operations/fs-vault-provider.ts`: `FsVaultProvider implements VaultProvider`, constructor accepts `ObsidianCLIProviderOptions` and constructs an internal `ObsidianCLIProvider`; all 6 methods delegate to it
- [x] 1.2 Swap the wiring in `src/server.ts` `buildDefaultVaultEntryDeps` from `ObsidianCLIProvider` to `FsVaultProvider` (one class name; `providerFactory` signature unchanged)
- [x] 1.3 Delegation tests via the `exec`/`stat` seams: each method forwards its arguments to the CLI provider and returns/throws its result unchanged; full suite (`npm test && npm run lint && npm run typecheck`) green with zero behavior change

## 2. Scan leg — listTags / listProperties from disk

- [ ] 2.1 Thread `reader` (and whatever the scan aggregation needs) into `IVaultEntryDeps.providerFactory` opts in `src/lib/vault-registry.ts` + `src/server.ts`
- [ ] 2.2 Implement `listTags` / `listProperties` as `{ name, count }` aggregation over the `query_notes` scan extractors; remove those two delegations
- [ ] 2.3 Tests: frontmatter tags counted, inline `#tags` ignored, property-key counts, empty vault; assert via the SDK gate (`reg.spec.inputSchema` + handler), not handler-only
- [ ] 2.4 Verify `get_vault_overview` is fully populated with no `obsidian` binary available

## 3. Daily leg — readDaily from daily-notes.json

- [ ] 3.1 Resolve the open question: confirm `read_daily`'s `notes_today` section is scan-based (if it touches the provider, pull it into this leg's scope)
- [ ] 3.2 Characterize current CLI behavior for a missing today-note (error code + how the resolved path reaches the caller) as a pinned test
- [ ] 3.3 Implement `readDaily`: parse `.obsidian/daily-notes.json` via `daily-notes-config.ts`, resolve today's path, read from disk; `DAILY_NOTES_NOT_CONFIGURED` on absent/unusable config; missing today-note matches the pinned behavior; remove the delegation
- [ ] 3.4 Tests: configured+exists, config missing, today-note missing (parity with 3.2)

## 4. Write leg — createNote / setProperty / removeProperty from disk

- [ ] 4.1 Implement `createNote` via `FsVaultWriter`: resolve vault-relative path, `NOTE_EXISTS` without `overwrite`, verbatim content (no templates); remove the delegation
- [ ] 4.2 Implement `setProperty` / `removeProperty` as frontmatter-only rewrites reusing the existing frontmatter helpers; body preserved byte-for-byte; `removeProperty` idempotent on absent keys; no `.obsidian/types.json` writes; remove the delegations
- [ ] 4.3 Tests: create-collision, overwrite path, property round-trips over representative fixture notes (body byte-identity), absent-key removal, ISO date/datetime validation parity
- [ ] 4.4 Headless smoke: run the server without an `obsidian` binary and exercise `create_note`, `read_daily`, `set_property`, `list_tags`, `get_vault_overview` end-to-end

## 5. Removal — delete the CLI path (major)

- [ ] 5.1 Delete the internal delegate field and `src/modules/operations/obsidian-cli-provider.ts`; drop `CLI_NOT_FOUND` / `CLI_UNAVAILABLE` / `CLI_TIMEOUT` mapping and their tests
- [ ] 5.2 Remove `--obsidian-cli` from `src/config.ts` and `binaryPath` threading from `IVaultRegistryConfig` / factory opts
- [ ] 5.3 Rewrite the "CLI availability" section of server instructions in `src/server.ts` (tools no longer need Obsidian; refresh the stale disk-direct list)
- [ ] 5.4 Docs: mint the ADR superseding ADR-0007 (vault writes go direct to disk), update `docs/architecture/` provider/tool notes and README claims about obsidian-cli
- [ ] 5.5 Assert the producible error-code set contains no `CLI_*` codes; changelog migration note for the removed flag; release as major
