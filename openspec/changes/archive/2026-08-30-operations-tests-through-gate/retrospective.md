# Retrospective: operations-tests-through-gate

> Written: 2026-08-30 (after verify passed, before PR 4 opened)
> Commit range: `ebd722c..HEAD` — PRs [#117](https://github.com/AlexMost/neuro-vault/pull/117), [#118](https://github.com/AlexMost/neuro-vault/pull/118), [#119](https://github.com/AlexMost/neuro-vault/pull/119) (merged) + three commits on `docs/gate-contract-adr`
> Tracking issue: [#112](https://github.com/AlexMost/neuro-vault/issues/112)

---

## 0. Evidence

- **Diff size**: +3 135 / −595 lines across 39 files. PR 1 +2 119/−123 (18 files), PR 2 +575/−226 (11), PR 3 +422/−279 (9), PR 4 +61/−9 (6).
- **Tasks done**: 28/28.
- **Deliverables**: four PRs — #117 gate helpers + `read_notes` + dead-code deletion, #118 the remaining nine operations files + the new `list_properties` file, #119 the semantic suite, PR 4 the durable record.
- **Test coverage signal**: 106 files / 1 333 tests, 0 failures (from 100 files / ~1 190 at `ebd722c`). eslint clean, `tsc --noEmit` clean, `prettier --check` clean, `openspec validate --all` 24/24. CI green on all three merged PRs.
- **Acceptance greps**: `\.handler(` across both tool suites returns 2 hits, both commented envelope-subject calls in `edit-note.test.ts`; `validateReadNotesInput|VALID_CONTENT_MODES` returns nothing.
- **Source deleted**: `validateReadNotesInput` and `VALID_CONTENT_MODES`, replaced by a three-line widening inlined into `buildReadNotesTool`.

---

## 1. Wins

- **The structural property did the work a judgment call could not.** Once every test enters through `callTool`, "no test asserts a code the gate makes unreachable" stops being something a reviewer checks and becomes something the seam enforces: 36 surviving `INVALID_ARGUMENT` assertions across nine files are now *proven* reachable, because each one runs on the far side of the gate and would receive `INVALID_PARAMS` instead if it were not. That is a property that survives the next contributor.
- **Re-throwing inside the helper made ~220 call-site edits mechanical.** Existing `rejects.toMatchObject({ code })` assertions survived verbatim; success assertions changed only from `tool.handler(x)` to `callTool(reg, x)`. The design bet that this would keep review cost per-file rather than per-call held across all three migration PRs.
- **The payload audit before writing the helper was the right order.** Checking `toToolResponse`'s `Object.getPrototypeOf(value) === Object.prototype` guard *first* found the two array-returning tools (`find_duplicates`, `get_similar_notes`) at design time. Had the helper been written first, those two files would have failed with an opaque `undefined` deref and the fallback would have been retrofitted under pressure.
- **Splitting into four PRs with a pause after PR 1 held.** The helper shape was reviewed against one real file before ~200 more call sites adopted it, and no intermediate commit was ever red.
- **The migration found real dead code in three places, not one.** The proposal predicted `read_notes`; the seam surfaced `readThreshold`'s range branch and all three `UNSUPPORTED_VALUE_TYPE` throws as well. Evidence beats prediction — and the ADR is stronger for citing three independent instances of the same failure mode.

## 2. Misses

- **The ADR's `search_notes` evidence was nearly overstated.** The apply briefing offered empty/over-long `query` and empty `filter.path_prefix` as gate-caught alongside `threshold`. Grepping the schemas before writing showed `z.union([z.string(), z.array(z.string()).min(1).max(8)])` — the bounds constrain only the *array* branch, so an empty string query still reaches the handler, and `search-notes.ts:164-170` handles `!== ''` deliberately. Only `threshold` is airtight. The "grep the symbol before asserting" rule caught this; nothing else would have.
- **Task 1.8 was left unchecked after PR 1 merged.** A checkbox for "open the PR and pause" has no natural moment to be ticked — the session that would tick it has already ended. Noticed three PRs later during the group-4 sweep.
- **`readThreshold`'s `Number.isFinite` branch was left unclassified.** Whether `z.number()` admits `Infinity` in zod 4 was not verified, so the ADR asserts only the range branch. Correct but incomplete: the follow-up removal will have to settle it.

## 3. Plan deviations

| Deviation | Why |
| --- | --- |
| Task 1.7 shipped as its own commit rather than folded into 1.3–1.6 | 1.3–1.6 touch no `src/` file and are green alone, so the split broke no intermediate commit. Recorded inline in `tasks.md`. |
| ADR-0003's body left untouched; the refinement recorded in its INDEX status cell only | An ADR is an immutable record of a decision as taken. Rewriting its Decision paragraph would erase the very statement ADR-0015 exists to narrow. |
| The docs sweep changed one file, not several | Seven `INVALID_ARGUMENT` mentions across `docs/`, `README.md`, `AGENTS.md`; six describe genuine semantic faults. Verified each rather than pattern-replacing — including `edit-note.ts`'s `replace: z.string().optional()` with no `.min(1)`, which makes the guide's "empty `replace`" line correct as written. |

## 4. Skill / workflow compliance

- Four PRs with a pause after the first, per the incremental-delivery rule — one opsx change ≠ one bundled PR.
- Every gate (`npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `openspec validate --all`) run before each commit and each PR.
- Verify ran before archive. It produced no critical or warning findings — the acceptance greps had already been run as Task 24 Step 1, so verify confirmed rather than discovered.
- `npm run format` is `prettier --check`, not a writer. Worth knowing before assuming a formatting task self-heals.

## 5. Surprises

- **The gate had been correct all along; only the docs and the tests were wrong.** No runtime behaviour changed in the entire change — production already returned `INVALID_PARAMS` for every case in question. What shipped was the removal of a *belief* about the system that three separate tools had independently coded against.
- **A handler-direct test is not merely weaker — it can be actively false.** The four `read_notes` pins were green, specific, and describing behaviour no client could ever observe. A passing test that enters past the boundary it claims to test is worse than a missing one, because it answers the question "is this covered?" with a confident yes.

## 6. Promote candidates → long-term learning

- **Test at the seam the client crosses, not one frame inside it.** When a test helper reaches past a boundary for ergonomic reasons, every assertion behind it silently becomes a claim about the wrong system. The fix is structural — make the ergonomic path *be* the seam — not a review convention.
- **When two instructions each look right, check whether one of them is still reachable.** ADR-0003 and the coercion gate were both followed faithfully. The bug was that following both made one unreachable, and nothing in either document could reveal that on its own.
- **A durable-doc claim of the form "every X does Y" needs the grep, every time.** Two claims in this change's ADR were narrowed by grepping (the `search_notes` bounds) and one was strengthened (all four `readThreshold` call sites, not just one). Both directions came from the same five-second check.
