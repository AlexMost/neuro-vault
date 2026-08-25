# Retrospective: own-corpus-indexer

> Written: 2026-08-25 (after verify passed, before PR #97 merged)
> Commit range: `24065b6..4599a6b` — PR #96 (merged, squashed as `dcba68b`) + six commits on `worktree-own-corpus-indexer-pr2`
> Worktrees: `.claude/worktrees/own-corpus-indexer` (PR 1), `.claude/worktrees/own-corpus-indexer-pr2` (PR 2)

---

## 0. Evidence

- **Diff size**: +5 488 / −12 lines across 36 files (PR 1: +4 682 / −6 across 26 files; PR 2: the rest)
- **Tasks done**: 45/45
- **Deliverables**: two PRs — [#96](https://github.com/AlexMost/neuro-vault/pull/96) extraction + storage, [#97](https://github.com/AlexMost/neuro-vault/pull/97) reconcile + docs
- **New external dependency**: `write-file-atomic` (ISC, pure JS, no native build, Node floor unchanged)
- **Test coverage signal**: 1 161 tests across 92 files, 0 failures (1 159 after PR 1, +2 in PR 2's own commits beyond the 21 reconcile cases); 108 of them cover the corpus library and the tokenizer cap. eslint clean, `tsc --noEmit` clean, `openspec validate --all` 14/14. CI green on both PRs.
- **Real-vault measurement** (842-note scratch copy): cold index 138.2 s / 5 423 vectors / ~13 MB; second pass 0.09 s, 842 reused, 0 embedded.
- **Bugs encountered post-merge**: none (PR 2 not yet merged).

---

## 1. Wins

- **The wayfinder map paid for itself.** Six research and grilling tickets had already settled chunking parity, storage format, exclusion semantics, change detection and the backend contract, so proposal and design were transcription rather than deliberation — and every hard number in the ADR (40 vectors/s, 68 ms cold load, the disqualifiers for LanceDB/hnswlib/sqlite) came from a measurement someone had already taken.
- **The tokenizer trap was caught before it cost anything.** Research 03 found `model_max_length = 1e15` while benchmarking, not while indexing; it entered the plan as a task and shipped with a regression test instead of as a production incident.
- **`vector = f(path, content, strategy)` turned an open question into a testable invariant.** Deciding that a rename re-embeds is what makes "incremental equals from-scratch" assertable at all — and that property test is the one that would catch a whole class of future reconcile bugs.
- **Splitting into two PRs held.** PR 1 shipped inert extraction and storage; PR 2 made it maintainable. Neither left the tree half-wired, and PR 1's review feedback (the CommonMark rewrite) landed before reconcile was built on top of it.

## 2. Misses

- **The ADR number went stale between design and apply.** design/plan/tasks all named `0012-own-embedding-corpus.md`; release 15.5.0 landed a different ADR-0012 in the meantime. Caught twice — once from stale local artifacts, once inside PR 1 — and fixed to 0013. A planned artifact path that encodes a globally-allocated number is a hostage to merge order.
- **`EmbeddingService`'s default `modelKey` was not a loadable model id.** PR 1 gave `MODEL_KEY` ("bge-micro-v2" — the corpus's record of *which model made the vectors*) one importable home and wired the service default to it. Nothing shipped broken, because production always passes the repo id from `config.ts`, but a default-constructed service resolved to a Hugging Face 404. Only the real-vault run found it; every unit test injects a fake pipeline, so the suite could not.
- **One scenario was asserted vacuously.** "An exclusion change is not a rebuild" was exercised on a single-note vault, which cannot show that untouched notes survive. Found by `/opsx:verify`, not by writing the test.
- **Two artifacts disagreed with each other.** The `vault-scope` delta said the corpus skips gated notes; `own-corpus-index` said a gated note still gets a vector-less shard. Both were written in the same session, and neither review caught it until verify read them side by side.

## 3. Plan deviations

| Deviation | Why |
| --- | --- |
| `ReconcileDeps` gained a `stat` port not in plan.md's Task 10 interface | Without it "skips the note without reading it" is unimplementable — the read would be the only metadata source. Recorded in `tasks.md` group 7. |
| Block detection uses the CommonMark AST, not the plan's line regexes | Decided during PR 1 review: the regex scanner's failure mode was silent content loss, and this was the cheapest moment to swap it (no corpus exists on any user's disk yet). Recorded as design D2 divergence 6. |
| `MODEL_ID` added and `config.ts` rewired — outside the task list | A default that always 404s is a trap for slices #3 and #5, which construct this service. Fixed with a regression test rather than left as a note. |
| ADR-0012 → ADR-0013 | Number taken by 15.5.0. |

## 4. Skill / workflow compliance

- Two PRs with a pause between them, per the incremental-delivery rule — one opsx change ≠ one bundled PR.
- Every gate (`npm test`, `npm run lint`, `npm run typecheck`, `openspec validate --all`) run before each PR and pasted into its body; CI confirmed both.
- Verify ran before archive and produced two real findings, both fixed before archiving rather than filed as follow-ups.
- The task-9.4 sanity script stayed in the session scratchpad and out of the repo, as the plan required — the CLI is slice #3.

## 5. Surprises

- **A no-op reconcile costs 0.09 s over 842 notes.** The `mtime`+`size` pre-check means a steady-state vault is answered entirely from shard metadata; the design's worry about reconcile reading every shard turned out to be the cheap half.
- **The corpus is small.** 842 notes → 5 423 vectors → ~13 MB, roughly a third of what the replaced corpus would hold, purely from dropping the vector-less block records.
- **Cold index landed at 138 s** — inside the predicted 1.5–3.3 min band, with SC-parity overlapping parent blocks included.

## 6. Promote candidates → long-term learning

1. **A planned ADR number is a guess, not a reservation.** Any change whose plan names `docs/adr/NNNN-*.md` must re-check the number at apply time; releases land between design and implementation.
2. **A constant that names an identity is not a constant that names a resource.** `MODEL_KEY` (what wrote the vectors) and `MODEL_ID` (what to load) look identical until one of them is used as a URL. Giving both one home is right; letting one default to the other is not.
3. **A test over a one-element collection cannot prove "everything else is untouched."** Any assertion about what a change *leaves alone* needs at least one element outside the change.
