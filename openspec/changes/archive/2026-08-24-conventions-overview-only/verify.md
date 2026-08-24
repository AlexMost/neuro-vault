# Verification Report

**Change**: `conventions-overview-only`
**Verified at**: 2026-08-24
**Verifier**: Claude Opus 5 (controller session, fallback path — `openspec-verify-change` skill not installed; the numbered checks below were run manually per the schema's documented fallback)
**Commit range**: `origin/main..HEAD` — `b5905c0..7b96110` (4 commits)

---

## 1. Structural Validation (`openspec validate --all`)

- [x] Every item `"valid": true`

```text
✓ spec/baseline
✓ change/conventions-overview-only
✓ spec/corpus-staleness-filtering
✓ spec/headless-vault-operations
✓ spec/hybrid-search
✓ spec/mcp-tool-surface
✓ spec/multi-vault-dispatch
✓ spec/read-notes-content-modes
✓ spec/tolerant-arguments
✓ spec/tool-response-envelope
✓ spec/type-aware-linting
✓ spec/vault-conventions-delivery
✓ spec/vault-scope
Totals: 13 passed, 0 failed (13 items)
```

| Item | Type | Issues |
| --- | --- | --- |
| — | — | none |

---

## 2. Task Completion (`tasks.md`)

- [x] 32 of 33 complete.

| Task | Reason not complete | Blocks archive? |
| --- | --- | --- |
| 7.4 — push the branch and open the PR | Runs after archive by the schema's own ordering: verify → retrospective → archive → PR, so the PR diff carries the complete archived cycle. | No — it is the step archive precedes. |

**Commit grouping.** Plan tasks 1 and 2 landed in one commit (`b5905c0`) rather than two. Task 1's step 7 explicitly expects the old suite to be red at that point, and the repo's Global Constraint requires all gates to pass before any commit; the constraint governs, so the pair was merged. Every task's substance was delivered.

**Execution mode.** The schema's apply instruction mandates `superpowers:subagent-driven-development`. This session is configured to forbid the Agent tool without explicit user request; the user was asked and chose direct implementation in an isolated worktree, keeping TDD (RED verified before GREEN on every code task) and the worktree requirement. Per-task code-review subagents were not dispatched. Recorded here rather than left implicit.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
| --- | --- | --- |
| `vault-conventions-delivery` | ✗ Needs sync | Expected at this point — `openspec archive` performs the sync. The delta's 4 MODIFIED headers and 1 REMOVED header were compared line-for-line against `openspec/specs/vault-conventions-delivery/spec.md` and match verbatim, so full-text replacement at archive will resolve. The 1 ADDED header is correctly absent from the main spec. |

Header comparison run:

```text
delta                                                              main spec
─────────────────────────────────────────────────────────────────  ─────────
ADDED    Instructions point at the overview channel for conventions  (absent) ✓
MODIFIED Composed instructions do not restate tool descriptions      line 32  ✓
MODIFIED Conventions are read at call time                           line 97  ✓
MODIFIED Each vault's conventions travel with that vault             line 128 ✓
MODIFIED An unreadable conventions file never fails a call           line 148 ✓
REMOVED  A vault's conventions survive the instructions …budget      line 6   ✓
```

---

## 4. Design / Specs Coherence

Spot-checked D1–D8 against the delta. No drift.

| Decision | Requirement it lands in | State |
| --- | --- | --- |
| D1 — cut the channel, don't patch it | REMOVED "…survive the instructions truncation budget" | ✓ |
| D2 — applies ADR-0010, does not reverse it | ADR-0012 §Decision; ADR-0010 untouched (ADR-0008 immutability) | ✓ |
| D3 — `buildServerInstructions` → module constant | MODIFIED "Composed instructions do not restate tool descriptions" | ✓ |
| D4 — pointer names the channel and the trigger | ADDED "Instructions point at the overview channel for conventions" | ✓ |
| D5 — budget test asserts a constant | Scenario "the budget holds unconditionally" | ✓ |
| D6 — delete the README claim | Not spec-bearing; verified in §6 sweep | ✓ |
| D7 — `CONVENTIONS_CHAR_CAP` stays 8,000 | Overview requirements untouched; constant unchanged at `src/lib/obsidian/vault-conventions.ts:13` | ✓ |
| D8 — one REMOVED, one ADDED, four MODIFIED | §3 header table | ✓ |

**Warning (non-blocking).** Design D4 measured 693 + 241 = 936 characters. Implementation measures **936** exactly — no drift.

**Note.** `tasks.md` 1.5 instructed deleting the `readVaultConventions` import from `src/server.ts`. That instruction was wrong: the symbol is still consumed at `src/server.ts:86` by `conventionsReaderFactory`, which feeds `IVaultEntry.readConventions` for the overview channel. `plan.md` step 5 already flagged this ("**Careful:** … keep the import"), and the plan was followed. No spec impact.

---

## 5. Implementation Signal

- [x] `git status --short` — empty. All changes committed.
- [x] Commit range `b5905c0..7b96110`, 4 commits, all carrying `Refs #93`.

**Gates, run verbatim:**

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | ✓ 85 files, **1051 passed**, 0 failed |
| Lint | `npm run lint` (`eslint .`) | ✓ clean, no output |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | ✓ clean, no output |
| Build | `npm run build` (tsup) | ✓ ESM + DTS build success |

**Acceptance criteria, checked against command output rather than inference:**

1. **Gates pass** — table above.
2. **No conventions content in composed `instructions`** — `test/server-instructions.test.ts > SERVER_INSTRUCTIONS > puts no vault conventions content into the instructions handed to the server` PASSED (verbose reporter, 5ms). It drives real `startNeuroVaultServer` wiring against a temp vault holding a distinctive `for-external-agents.md`, so it catches composition anywhere in `server.ts`, not only in the constant.
3. **Under 2048 unconditionally** — measured live:
   ```text
   SERVER_INSTRUCTIONS length: 936
   under 2048: true
   names get_vault_overview: true
   exports buildServerInstructions: false
   ```
   Independence from vault configuration is structural: a `const` with no inputs cannot vary. The spec scenario "the string does not vary with the registry" is asserted this way plus behaviourally by criterion 2, rather than by composing two registries and diffing — composing two registries is no longer expressible once the export takes none, and that impossibility *is* the guarantee.
4. **No doc claims a per-vault `instructions` block or an 8,000-character `instructions` budget** — §6.

**Scope containment.** The four overview-channel test files (`test/lib/obsidian/vault-overview.test.ts`, `test/lib/obsidian/vault-conventions.test.ts`, `test/operations/tools/get-vault-overview.test.ts`, `test/operations/resources/vault-overview.test.ts`) pass with **zero edits** — 36 tests green. Plan task 2 step 5 made any edit there a stop condition; none was needed.

---

## 6. Front-door Routing Leak Detector

`ls docs/superpowers/specs/*.md` → no such directory. **No leak.** (Consistent with ADR-0011 retiring that layer.)

**Repo-wide claim sweep**, run over all of `docs/`, `README.md`, `src/`, `test/`, `openspec/` — not just `docs/architecture/`:

| Sweep | Result |
| --- | --- |
| `instructions` near `conventions` | One stale claim found **outside the plan's named file list**: `docs/architecture/README.md:10` still advertised "the `instructions` ordering and 2048-character budget". Fixed in `7b96110`. Remaining live hits all describe the pointer or the removed behaviour historically. |
| `8,000` / `8000` | Every live hit attributes the number to the overview channel's `CONVENTIONS_CHAR_CAP`. No hit offers it as an `instructions` budget. |
| `buildServerInstructions` / `STATIC_SERVER_INSTRUCTIONS` | No hit in `src/`, `test/`, or `docs/architecture/`. The only live-doc hit is ADR-0012's deliberate historical account. |

`docs/adr/0010-context-delivery-channels.md` still describes conventions travelling on both channels. Left as written — ADRs are immutable (ADR-0008), and ADR-0012 records the change and states its relationship to ADR-0010 explicitly.

---

## 7. Deferred Dogfood vs Automated-Test Equivalence

`plan.md` contains **no `[~]` deferred rows**. Section N/A.

One check is inherently manual and is documented rather than deferred: observing the new `instructions` string in a live client requires a **fresh session**, because in Claude Code `/mcp reconnect` does not rebuild the session's system prompt. This is recorded in `docs/guide/configuration.md`, `docs/architecture/vault-conventions.md` §Boundaries, and ADR-0012 §Consequences, so the next person to check does not read a false negative as a failed change. Its automated equivalent — that the string handed to the server factory is exactly `SERVER_INSTRUCTIONS` and carries no vault content — is criterion 2 above.

---

## Overall Decision

**PASS.**

All 13 openspec items valid. 32/33 tasks complete, the one remaining being the PR that archive precedes. Four gates green on verbatim commands. All four acceptance criteria verified against real output. Delta headers match the main spec verbatim, so archive's full-text replacement will apply cleanly. No blocking issues; no warnings that change the outcome.
