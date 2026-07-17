# Retrospective: migrate-off-obsidian-cli

> Written: 2026-07-17 (after verify passed)
> Commit range: `1be2cd7..819b912`
> Worktree: `.claude/worktrees/migrate-off-obsidian-cli` (branch `worktree-migrate-off-obsidian-cli`, not yet merged)

---

## 0. Evidence

- **Commit range**: `1be2cd7..819b912` (19 commits; +1 archive/PR commits to follow)
- **Diff size**: +2517 / −940 across 47 files
- **Tasks done**: 20/20
- **Active hours**: ~1 session (subagent-driven, continuous)
- **Subagent dispatches**: 20 (10 implementers + 8 task reviewers + 1 fix + 1 final whole-branch review; Task 8 & Task 9 reviews ran on opus, rest sonnet; implementers haiku/sonnet/opus by task complexity)
- **New external dependencies**: none (reused `yaml`, `fast-glob` already present)
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass (`openspec validate --all` green pre-apply; re-checked at archive)
- **Test coverage signal**: vitest 748 passing at HEAD (753 baseline − 30 deleted CLI-provider tests + 25 new disk/renderer/config/sweep tests)

Commit chain (chronological):

```
f82ceb8 docs(openspec): add migrate-off-obsidian-cli change artifacts
30c89d1 feat(operations): add FsVaultProvider delegating to ObsidianCLIProvider
b67cd27 refactor(server): wire FsVaultProvider as the vault provider
dd4771a docs(openspec): check off Group 1 tasks
0cdca89 feat(operations): thread vault reader into providerFactory
d27957b feat(operations): disk-direct listTags and listProperties
8036fc6 feat(obsidian): minimal moment-format renderer for daily note paths
ff4d08c feat(operations): disk-direct readDaily
a29c38c docs(openspec): check off Group 3 tasks
ea2e728 feat(operations): disk-direct createNote
2e118c7 feat(operations): disk-direct property writes, drop CLI delegation
15b3201 docs(openspec): check off Group 4 write-leg tasks
1c09f26 feat(operations)!: remove ObsidianCLIProvider and the --obsidian-cli flag
c0c47fd refactor(operations): drop dead CLI_ERROR code and broaden CLI sweep
ce7a4c1 docs: record disk-direct vault operations, supersede ADR-0007
050fe4f docs: correct comma-restriction rationale for set_property
900302e docs(openspec): check off Group 5 removal tasks
5d1cd3a docs(openspec): check off headless smoke (4.4)
819b912 docs(openspec): add verify report
```

---

## 1. Wins

- [evidence: whole commit chain] **Zero-regression strangler-fig held.** Every intermediate commit passed `npm test && lint && tsc`; `get_vault_overview` (the uncaught `Promise.all` fan-in that motivated rejecting stubs in the first place) worked at every step — proven headless once `listTags`/`listProperties` migrated (`d27957b`) and never broke after.
- [evidence: `8036fc6` review] **The review loop caught a latent bug in the plan itself.** The plan's Task 5 reference code for `formatDailyDate` would have silently rendered `MMMM` as `MM`+`MM`; the implementer added rejection guards and the reviewer confirmed the improvement. The plan's example code was treated as a starting point, not ground truth — exactly the intended discipline.
- [evidence: `050fe4f`] **Docs-accuracy review caught a fabricated rationale.** Task 10 first justified the kept comma-restriction with a false serialization mechanism; the review flagged it (the `yaml` lib quotes commas fine) and it was corrected to "a validation retained from the earlier CLI-based implementation."
- [evidence: `c0c47fd`] **Removal was tightened beyond the plan.** The final review noted the spec says "no `CLI_*` in src/" while the sweep only checked three codes and a dead `CLI_ERROR` lingered; both were fixed and the sweep broadened to `CLI_`, turning a one-time check into a standing regression guard.
- [evidence: headless smoke in verify.md §Correctness] **End-to-end headless proof, not just unit tests.** With `obsidian` off `PATH`, all five tools drove a temp vault through the real production factory wiring — the acceptance criterion met with observed behavior.

## 2. Misses

- 🟡 [painful | evidence: `1c09f26` report] **The plan under-specified Task 9's touchpoints.** The removal map in plan.md named `set-property.ts` but missed the `obsidian-cli` references in `tool-helpers.ts:57,96`; the controller had to grep the full surface and hand the implementer a complete map at dispatch time. A "grep for every `obsidian-cli`/`CLI_`/`binaryPath` token" step belonged in the plan.
- 📌 [nit | evidence: `d27957b` → `2e118c7`] **A test churned across tasks.** The "propagates CLI errors unchanged" delegation test was rewired through `setProperty` in Task 4, then deleted in Task 8 when `setProperty` stopped delegating. Foreseeable from the plan; could have been retired once rather than moved then removed.
- 📌 [nit | evidence: verify.md §SUGGESTION 5] **YAML round-trip reformats untouched flow-style arrays** (`[alpha, beta]` → `[ alpha, beta ]`) and normalizes frontmatter CRLF→LF. Cosmetic and semantically lossless, but the "preserve formatting of untouched keys" goal isn't perfectly met for flow scalars. Only surfaced by the headless smoke, not by any unit test.
- 📌 [nit | evidence: verify.md §SUGGESTION 2,3] **Pre-existing/adjacent debt left in place** (deliberately, to keep scope): `vault-reader.ts` ignores its `fields` filter so hot-path listings read full bodies; dead union members (`PROPERTY_NOT_FOUND`) remain; test fixtures still use `CLI_*` strings as opaque codes.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 5 | Added `MMM`/`YYY`/`DDD` rejection guards absent from the plan's reference code | Plan code had a silent-degradation bug; review caught it |
| Task 9 | Reworded `obsidian-cli` messages in `tool-helpers.ts` (not in plan's file list); removed dead `CLI_ERROR`; broadened sweep to `CLI_` | Complete grep surfaced touchpoints the plan missed; final review pushed the tighter sweep |
| Task 10 | `cli-write-defenses.md` renamed to `disk-write-path.md`; `error-mapping-cli.md` deleted; `vault-provider.md` stale interface listing corrected | Judgment calls the plan left open; adjacent stale doc fixed in-place |
| 4.4 | Headless smoke run at the very end (post-removal) instead of inside Task 8 | Strongest evidence is after the CLI is fully gone — no fallback to mask a gap |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:using-git-worktrees                  | ✅ (EnterWorktree native tool; artifacts committed before fresh-from-origin worktree) |
| superpowers:subagent-driven-development          | ✅ (fresh implementer + task reviewer per task, ledger, final whole-branch review) |
| superpowers:test-driven-development (transitive) | ✅ (RED→GREEN evidence in every task report) |
| superpowers:requesting-code-review (transitive)  | ✅ (per-task + final review; Critical/Important fixed, Minors triaged) |
| openspec verify (opsx:verify)                    | ✅ (verify.md PASS; gates re-run fresh) |
| superpowers:finishing-a-development-branch       | ⏳ (next — PR is the last step) |

## 5. Action items (follow-ups — none merge-blocking)

1. Honor `ReadNotesInput.fields` in `FsVaultReader.readNotes` so frontmatter-only scans skip full-body reads (perf on large vaults). — own session
2. Dedup tags within a note in `listTags` (`new Set(extractTags(fm))`). — trivial
3. Remove dead `OperationsErrorCode` members (`PROPERTY_NOT_FOUND`, audit rest). — cosmetic
4. Swap `CLI_*` fixture strings in `get-vault-overview`/`list-tags`/`fan-out` tests to `READ_FAILED`. — hygiene
5. Decide whether the retained no-comma-list / ISO-date `set_property` validations should relax now that the CLI's encoding limits are gone (a deliberate input-contract decision, out of this change's scope).
6. Tighten the `NOTE_EXISTS` create test to assert `details.path`.
