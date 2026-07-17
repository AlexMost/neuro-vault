# Verification Report: migrate-off-obsidian-cli

Verified at HEAD `900302e` + `4.4` checkoff commit, branch `worktree-migrate-off-obsidian-cli` (base `origin/main` 1be2cd7).

## Summary

| Dimension    | Status                                                            |
| ------------ | ----------------------------------------------------------------- |
| Completeness | 20/20 tasks complete; 6/6 spec requirements implemented           |
| Correctness  | 6/6 requirements covered by tests + a headless end-to-end smoke   |
| Coherence    | Design D1–D6 followed; strangler-fig landed; docs (ADR-0009) sync |

**Final assessment: All checks passed. Ready for archive.** No CRITICAL or WARNING issues. Non-blocking SUGGESTIONs (follow-ups) listed below.

## Verify gates (openspec/config.yaml rules.verify)

| Gate                 | Result                                                    |
| -------------------- | --------------------------------------------------------- |
| `npm test`           | ✅ 748 passed (exit 0)                                    |
| `npm run lint`       | ✅ eslint clean (exit 0)                                  |
| `npx tsc --noEmit`   | ✅ typecheck clean (exit 0) — source of truth             |
| `npm run build`      | ✅ tsup build success (supplementary)                     |

**Test-count note (rules.verify "count must not drop unintentionally"):** baseline was 753; HEAD is 748. The change is intentional and accounted for: Task 9 deleted `test/operations/obsidian-cli-provider.test.ts` (the ~30-test suite for the removed `ObsidianCLIProvider`), while the migration added disk tests for all 6 methods, `daily-note-path` tests, a `--obsidian-cli`-rejection config test, and a `CLI_` grep-sweep test. Net −5 is the deletion of a now-nonexistent unit's tests, not lost coverage.

## Completeness

**Tasks:** all 20 checkboxes in `tasks.md` are `- [x]` (Groups 1–5). Verified 0 unchecked.

**Spec requirements** (`specs/headless-vault-operations/spec.md`) — all implemented:

1. **Vault operations run without Obsidian** → `src/modules/operations/fs-vault-provider.ts` (all 6 methods disk-direct); proven by the headless end-to-end smoke (below) and `test/operations/fs-vault-provider.test.ts` "get_vault_overview core fully populated with a dead CLI".
2. **Tag/property listings aggregate from the frontmatter scan** → `fs-vault-provider.ts` `listTags`/`listProperties`/`scanFrontmatter`/`sortCounts`; tests: frontmatter-tags-counted, inline-`#tags`-ignored, property-key-counts, empty-vault.
3. **Daily note resolution reads daily-notes.json** → `fs-vault-provider.ts` `readDaily` + `src/lib/obsidian/daily-note-path.ts` `formatDailyDate` + existing `readDailyNotesConfig`; tests: configured+exists, config-missing (`DAILY_NOTES_NOT_CONFIGURED`), today-note-missing (`NOT_FOUND` with `details.path`).
4. **Write methods edit vault files directly** → `createNote` (`wx`/`w` write, `NOTE_EXISTS`), `setProperty`/`removeProperty` (yaml `parseDocument` round-trip, body byte-identity, idempotent absent-key, last-key strips block); tests cover each.
5. **Dropped Obsidian conveniences are explicit non-behavior** → verbatim content (no templates); `.obsidian/types.json` never written (test asserts absence).
6. **No external process dependency remains** → `obsidian-cli-provider.ts` deleted; `--obsidian-cli` removed (`test/config.test.ts` asserts it errors as unknown option); `CLI_*` codes removed; `test/operations/fs-vault-provider.test.ts` grep-sweep asserts no `CLI_` token remains in `src/`.

## Correctness

Every requirement is backed by tests that fail on regression (verified RED→GREEN per task during subagent-driven development, and re-confirmed by the final whole-branch review on model opus: **verdict "Ready to merge"**, load-bearing behaviors independently checked — frontmatter round-trip keeps ISO dates unquoted so Obsidian still reads them as dates; production wiring `server.ts` → `vault-registry.ts` `providerFactory` → `FsVaultProvider` correct end-to-end; error surface matches tool-layer/fan-out expectations).

**Headless end-to-end smoke (acceptance 4.4):** with `obsidian` absent from `PATH`, drove all five tools against a temp vault via the production factory wiring: `create_note` (incl. `name`→`Inbox/` via `.obsidian/app.json`), `read_daily` (`Daily/2026-07-17.md`, frontmatter parsed), `set_property` (`priority: 2` persisted to disk, verified by re-read), `list_tags` (`alpha`/`beta` from frontmatter), `get_vault_overview` (folders + top_tags + properties populated). No `CLI_*`/`obsidian` reference leaked into any result.

## Coherence

- **Design decisions D1–D6 followed:** no config flag (D1); no stub window — delegation then per-method replacement (D2); `FsVaultProvider` accepted the CLI options bag during migration and is now narrowed to `{ vaultRoot, reader }` (D3); `reader` threaded lazily when first needed (D4); disk implementations reuse existing infra — `FsVaultReader.scan`, `extractTags`, `readDailyNotesConfig`, `splitRawFrontmatter`/`serializeFrontmatter`, `buildBasenameIndex` (D5); error-code parity per method, `CLI_*` family removed at the end (D6).
- **Docs synchronized:** ADR-0007 marked Superseded; ADR-0009 minted + indexed; `cli-write-defenses.md`→`disk-write-path.md`; `error-mapping-cli.md` removed; guide/README swept of `obsidian-cli`/`--obsidian-cli`/`CLI_*` references (frozen `docs/superpowers/specs/` and archived changes correctly untouched).
- **Breaking change recorded:** commit `1c09f26` carries `feat(operations)!:` + `BREAKING CHANGE:` footer, so `commit-and-tag-version` will emit the major-version changelog entry at release.

## Issues

### CRITICAL — none.
### WARNING — none.

### SUGGESTION (non-blocking follow-ups; recorded in retrospective)

1. `fs-vault-provider.ts` `listTags` — no per-note tag dedup: `tags: [alpha, alpha]` counts `alpha` twice. One-line fix `new Set(extractTags(fm))`. Pathological input only.
2. `src/lib/obsidian/vault-reader.ts` (pre-existing) — `ReadNotesInput.fields` never consulted; `readNotes` always reads full bodies even when only `frontmatter` is requested. Now on a hot path (`listTags`/`listProperties`/`get_vault_overview`). Perf-only, separate change.
3. Dead error-code union members — `PROPERTY_NOT_FOUND` (and audit the union) have no producer left after the CLI removal. Cosmetic type cleanup.
4. Test fixtures in `test/operations/tools/get-vault-overview.test.ts`, `list-tags.test.ts`, `test/lib/fan-out.test.ts` use `CLI_NOT_FOUND`/`CLI_UNAVAILABLE` as arbitrary error-code strings (`ToolHandlerError.code` is `string`; src/ sweep unaffected). Swap to `READ_FAILED` for readability.
5. YAML round-trip re-emits an untouched flow-style array `tags: [alpha, beta]` as `tags: [ alpha, beta ]` (canonical flow spacing) when another property is set on the same note — cosmetic, semantically identical; inherent to the `yaml` library. CRLF line-endings inside frontmatter are likewise normalized to LF (body byte-identity is preserved).
6. `test/operations/fs-vault-provider.test.ts` — the `NOTE_EXISTS` create test asserts only `{ code }`, not `details.path` (the code sets it correctly). Tighten the assertion.
7. `read_daily` reads `.obsidian/daily-notes.json` twice (tool preflight + provider resolution). Harmless defense-in-depth; could thread a single resolution.
