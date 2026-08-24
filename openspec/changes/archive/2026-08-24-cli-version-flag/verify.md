# Verification Report

**Change**: `cli-version-flag`
**Verified at**: `2026-08-24 18:40`
**Verifier**: Claude Opus 5 (opsx apply controller), on branch `worktree-cli-version-flag`

**Overall Decision: PASS** — no blocking issues.

---

## 0. Repo-wide gates

| Gate | Command | Result |
|---|---|---|
| Tests | `npm test` | ✓ 1062 passed, 86 files (baseline was 1056/85 — +6 tests, no drop) |
| Lint | `npm run lint` | ✓ clean, exit 0 |
| Typecheck | `npx tsc --noEmit` | ✓ clean, exit 0 (authoritative — a `tsup` build is not a substitute) |
| Format | `npm run format` | ✓ clean |
| **Built bundle** | `node dist/cli.js --version` | ✓ printed `15.4.0`, exact match to the manifest, exit 0 |
| **Built bundle** | `node dist/cli.js --help` | ✓ exit 0, `--vault is required` confirmed absent by grep |

The two bundle checks are the ones no source-level test can make: they are the only way to catch a wrong `createRequire` path depth in `src/package-meta.ts`. They are now also enforced on every push — see §4.

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result**: 13 items, 0 invalid — `baseline`, `cli-version-flag`, `corpus-staleness-filtering`, `headless-vault-operations`, `hybrid-search`, `mcp-tool-surface`, `multi-vault-dispatch`, `read-notes-content-modes`, `tolerant-arguments`, `tool-response-envelope`, `type-aware-linting`, `vault-conventions-delivery`, `vault-scope`.

| Item | Type | Issues |
|---|---|---|
| — | — | none |

---

## 2. Task Completion (`tasks.md`)

- [x] All checkboxes are `- [x]` — 17 of 17, 0 remaining.

| Task | Reason incomplete | Blocks archive |
|---|---|---|
| — | — | — |

One deviation from the plan's task boundaries, ruled on during apply and recorded here for the record: the `src/cli.ts` narrowing that plan Task 3 Step 3 specified landed inside Task 2's commit, because changing `parseConfig`'s return type broke `cli.ts` compilation and Task 2's own gate required `npm run typecheck` to pass. Task 3 therefore shipped as test-only. The final whole-branch review audited this and judged it sound. No requirement went unimplemented.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
|---|---|---|
| `cli-startup-flags` | ✗ Needs sync | `openspec/specs/cli-startup-flags/` does not exist yet. This is the expected pre-archive state — `openspec archive` performs the sync. Not a defect. |

---

## 4. Design / Specs Coherence Spot Check

| Sample | design.md | specs/ | Gap |
|---|---|---|---|
| Output format | D1 — bare version number, no program name | R1 scenario "prints the manifest version" — "a bare version string with no program name, prefix, or surrounding text" | none |
| Detection mechanism | D3 — read `argv.help` / `argv.version` after `.parse()` | R2 — "the argument parser has itself fulfilled the invocation" (states the property, not the mechanism) | none — spec correctly stays mechanism-agnostic |
| Representable early exit | D4 — discriminated union so the state is not unrepresentable | R2 — "MUST be an explicit, representable outcome rather than an unhandled path that falls through" | none |
| Single version source | D5 — one module, at `src/` root depth | R3 — "read ... in exactly one module" + the build-output verification clause | none |
| New capability | D6 — new spec rather than amending an existing one | `specs/cli-startup-flags/` is the only delta directory | none |

**Drift warnings**: none.

Scenario-level coverage was walked independently by the final whole-branch review, which mapped all nine scenarios across the three requirements to `file:line` and found every one satisfied. Notably it re-probed this repo's yargs 18 across twelve invocations and confirmed there is no path where `--version`/`--help` can reach the transport, and that `--no-version` / `--version=false` correctly fall through to the `--vault` guard because the check is strict `=== true`.

---

## 5. Implementation Signal

- [x] No unstaged or modified source files in the worktree
- [ ] Commits pushed — **not yet**; the branch is local. Push happens with the PR, which per the apply sequence comes after retrospective + archive.

**Commit range**: `c3448df..c81bdc6` (5 commits)

```
c81bdc6 test(cli): close review gaps in --version smoke coverage
34d725a docs: describe CLI startup and document --version
85a32ce fix(cli): exit 0 on --version and --help without starting the server
7bfb0c9 feat(cli): add --version and stop --help falling through
9fbdfde refactor: read package.json from one module
```

`git status` shows one untracked path: `openspec/changes/cli-version-flag/`. This is the change's own artifact directory, expected to be untracked at this point — it is committed together with this report and the retrospective, after archive, as the final bookkeeping commit.

**User-facing reference check** (required when a change alters a user-facing contract): this change adds a CLI flag, not a tool schema. `docs/guide/configuration.md` gained the `--version` row in the same change, and `docs/architecture/cli-startup.md` was added and linked from the architecture index. A docs sweep over `README.md` and all of `docs/` was run by the implementer and independently re-run by the reviewer; the configuration table was the only real flag listing.

---

## 6. Front-Door Routing Leak Detector (warning, non-blocking)

- [x] No files — `ls docs/superpowers/specs/*.md` returns no matches.

| File | Captured in change? | Action |
|---|---|---|
| — | — | — |

Brainstorm output was written to `openspec/changes/cli-version-flag/brainstorm.md` as the schema's redirection requires. No leak.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains **zero** `[~]` deferred rows — every step was executed in this cycle, including the build-output checks that a plan of this kind would normally defer.

| Deferred dogfood | Equivalent automated test | Coverage assessment | Real gap? |
|---|---|---|---|
| — (none) | — | — | — |

Worth recording: the build-output check was the one manual step at risk of becoming a permanent deferral. The final review flagged that CI ran `npm run build` but never executed the result, leaving the spec's "MUST be verified against the build output" clause with no standing guard. Commit `c81bdc6` added a `Smoke the built binary` CI step that runs `dist/cli.js --version` against the manifest version on every push, so this row is now covered by automation rather than by a one-time manual act.

---

## Issues

### CRITICAL (must fix before archive)

None.

### WARNING (should fix)

None.

### SUGGESTION (nice to fix)

- `-v` is not aliased to `--version` (`src/config.ts:76-77` registers long forms only), so `-v` returns `Unknown argument` and exits 1. Deliberately parked during apply: a short alias widens the flag contract this change just tightened, and the design's Non-Goals exclude it. Reasonable follow-up if users ask for it.
- `src/config.ts` declares the `ParsedCli` type among the vault-parsing helpers rather than immediately above `parseConfig`. Cosmetic; triaged as acceptable by the final review.

---

## Final Assessment

All checks passed. Ready for archive.

Five commits, +6 tests, every repo gate green, all nine spec scenarios verified satisfied with `file:line` evidence, and the one failure mode the spec singles out as invisible to source-level testing now has a standing CI guard.
