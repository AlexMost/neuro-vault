# Retrospective: embedding-model-profiles

> Written: 2026-10-13, after verify passed with warnings (`verify.md`).
> Commit range of this cycle (PR 4): `2ffd2ee..f40595e`. PRs 1–3 merged earlier as #135, #140 and #141.
> Worktree: `.claude/worktrees/emp-pr4`, branch `feat/embedding-model-profiles-pr4`.

This retro covers PR 4, the last of four. The earlier PRs had their review stops in their own sessions, and PR 3's reconciliation block in `plan.md` carries their lessons forward. Where a finding is about the change as a whole, it says so.

---

## 0. Evidence

- **Commit range (PR 4)**: `2ffd2ee..f40595e`, 24 commits. Five are `docs(openspec)` plan/decision commits made before or around the code, five are `feat`/`fix` commits, and the rest are docs.
- **Diff size (PR 4)**: 49 files, +1583 / −376.
- **Tasks done**: 42/45 when this retro was written. 14.2 is this retro; 14.3 (archive) and 14.4 (PR) come after it by design. The plan grew by two tasks during the cycle: 11.0 (the D11 decision) and 13.4 (the owner's request).
- **Active hours**: one session, about 4 h. About 1.5 h of that was real-data indexing: four cold indexes on vault-copy clones, about 55 min of CPU time in total.
- **Subagent dispatches**:
  - 10 implementer dispatches: 11.0, 11.1, 11.2, 11.3, 12.1 step 3, 13.1, 13.2, 13.3+13.4 batched, the `TBD-12.1` fill and the final-review fix wave.
  - 4 resumed fix rounds.
  - 14 review dispatches: 9 task reviews, 4 scoped re-reviews and 1 final whole-branch review on Opus.
  - 1 verify-mapping agent.
  - The real-data runs (baseline, three calibrations, acceptance) were run by the controller, per ledger ruling.
- **New external dependencies**: none in PR 4. PR 1 added `@huggingface/transformers` 4.3.1.
- **Bugs encountered post-merge**: not merged yet.
- **OpenSpec validate state at archive**: 19/19 pass before archive. The archive run re-checks it.
- **Test coverage signal**: 1553 passed / 4 skipped vs 1541 / 5 on `main`. That is +12 tests; one fewer is skipped because the CI-only tokenizer test lost its bge row. 95 scenarios: 90 test-covered, 1 CI-only, 2 real-data, 2 uncovered (verify W2/W3).

Commit chain:

```
47f61bf docs(openspec): reconcile PR 4 tasks against main after PR 3
9f453df docs(openspec): calibrate thresholds on unranked populations (design D11)
8a70ec4 feat(eval): match similarity defaults on unranked populations                  [11.0]
9a0d587 feat(corpus): record the full producing identity in manifest v2                 [11.1]
aff06e3 docs(openspec): record the owner's ruling on fallback and expansionFloor (D11)
8eec7f5 feat(corpus): bound note text by tokens, not a character budget                 [11.2]
c87feb1 docs(openspec): re-capture the bge-micro baseline on unranked populations       [11.0 data]
e6ff27b docs(openspec): add a guide page on choosing the embedding model (Task 13.4)
7794368 feat(semantic)!: default to the harrier-270m embedding profile                  [11.3]
5679e54 docs(architecture): sweep …  ·  ba6c5a7 fix round                                [13.2]
72fbda2 docs: sweep the guide …  ·  e91442f docs(guide): new page  ·  b70ea2a fix round  [13.3, 13.4]
70037f7 docs(adr): ADR-0017  ·  d68e9de fix round                                         [13.1]
f31b3fe feat(semantic): calibrate each profile's similarity defaults on its own scale   [12.1]
9cc1775 docs(openspec): record acceptance measurements                                  [12.2]
89e76f8 docs: fill in the measured calibration and acceptance numbers
6d9dadd docs(openspec): mark PR 4 tasks 11.0–13.4 done
d9ee439 fix(semantic): drop a one-model scale claim from expansion_floor                [final review]
d4da997 docs: address the final review  ·  163eb3e docs(guide): count the switching rules
f40595e docs(openspec): verify embedding-model-profiles (pass with warnings)            [14.1]
```

---

## 1. Wins

- [evidence: `47f61bf`, `plan.md` "Reconciled against main @ 2ffd2ee" (e)] Reconciling the snippets before any code found every break Task 11.3 would cause. That included one the plan never mentioned: `test/semantic/embedding-service.test.ts` used bge as its only mean-pooling profile. 11.3 then landed in one implementer pass with no fix round (`7794368`).
- [evidence: `c87feb1`, `calibration.md` § unranked baseline] Re-capturing the bge baseline on the same vault copy as the calibration paid off. It reproduced PR 3's metrics exactly (MRR 0.398, the same `vault_sha` `98b8364`). Every later `--baseline` run was a clean paired comparison with no comparability warning. Cloning the copy per profile (`rsync --exclude .neuro-vault/corpus`) kept the `vault_sha` shared, so guard re-runs needed no re-index.
- [evidence: `calibration.md` § harrier-270m, "English slice below the acceptance bar"] A ten-line probe (`stored == fresh` cosine for q015's top 10, plus the per-query rank table) turned "EN MRR missed the bar" from a possible pipeline regression into a measured near-tie within minutes. Without it the cycle would have stalled on systematic debugging of tokenisation and pooling, which were not at fault.
- [evidence: `5679e54`, `72fbda2`, `70037f7` vs `89e76f8`] Running the docs tasks during the 35-minute harrier-0.6b index, with `TBD-12.1` markers, then filling all 71 markers in one batch kept the docs off the critical path.
- [evidence: fix rounds `ba6c5a7`, `b70ea2a`, `d68e9de`, `d4da997`] The review seats caught real errors in durable text, none of them cosmetic:
  - a reversed threshold direction in `finding-notes.md`;
  - an invented "25 min at 50k vectors";
  - a false "Qwen3 is dominated on size and speed" in the ADR;
  - an overclaim that every tool description interpolates thresholds;
  - an ADR that settled the owner's open EN decision ("We accept it");
  - a mermaid label that would not render.

## 2. Misses

- 🟡 [painful | evidence: `9f453df` then the tripped rule in `aff06e3`] The D11 decision was written before the bge minima on the new populations were looked at. `fallback` (0.30) sits below `query_all`'s minimum (0.337), and `expansionFloor` (0.35) below `seed_all`'s (0.471). One `quantiles()` call on the PR 3 corpus would have shown this before the design commit, and would have put the right question to the owner first time. Instead it cost a decision commit, a re-capture, and two rounds of explanation with the owner. The second was needed because the first question was framed in jargon.
- 🟡 [painful | evidence: first commit attempt on `47f61bf`] The fresh worktree had no `node_modules`. `npx eslint` resolved up the tree to the main checkout's install, and the pre-commit hook failed on type-aware rules (`no-unsafe-call`). The rules were right; the types resolved to `any`. `npm ci` in the worktree fixed it.
- 🟡 [painful | evidence: verify W1, `calibration.md` § Acceptance] The acceptance bar EN MRR ≥ 0.8 sits on 4 queries, and the bake-off cleared it by one rank (0.812). Any small change in the indexed text was likely to cross it. Here, the uncut note text and a slightly different vault state moved one relevant note from rank 4 to 7. The bar can't tell a regression from noise, and it now needs an owner ruling to ship.
- 🟡 [painful | evidence: cold-index times in `calibration.md`] All cold-index timings overlapped test runs or review agents. They are upper-side and labelled so, but the 7.9 vs 8.8 min spread for the same profile shows the noise. Clean timings would have meant serialising the agents behind the indexes.
- 📌 [nit | evidence: `b70ea2a`, `d68e9de`] Docs implementers twice produced numbers that weren't in the numbers file ("25 min", "comparable on English"), even though the brief said "never invent". The review rubric that classes an invented number as Important caught both. Without it they would have shipped.
- 📌 [nit | evidence: task_6c065b52] The `SEMANTIC_INDEX_NOT_FOUND` hint never carried `--model`. No spec required it; the plan's 13.2 text assumed it did. The docs sweep found it, it is now documented as a known gap, and a follow-up is filed.
- 📌 [nit | evidence: verify W2–W4] Two spec scenarios from PRs 1–2 had no test, and one SHALL ("every returned vector has the profile's dimension") was never enforced. Each PR's task reviews were scoped to that PR's diff, so only a whole-change requirement mapping could see this. It ran first at PR 4's verify.

## 3. Plan deviations

| Plan task | What changed | Why |
| --------- | ------------ | --- |
| PR 4 start | Branch `feat/embedding-model-profiles-pr4` (plan said `-4`); worktree created in this session | The worktree the brief described didn't exist yet |
| 11.0 (new) | Unranked populations in `eval/stats.ts` + baseline population refusal; bge baseline re-captured before 11.3 | Owner's D11 decision: five of six bge defaults passed 100 % of the ranked populations |
| 12.1 | `fallback`/`expansionFloor` set just below each profile's own unranked minimum, rounded down to 0.05 | Owner's ruling (design D11 "Outcome of the rule") when D11's stop rule tripped |
| 12.1 | No re-sync of the vault copy; one clone per profile | Keeps every run paired with the baseline's `vault_sha` |
| 12.1 | Real-data steps run by the controller; only Step 3 (pin) dispatched | They need the scratchpad copy, the stop rule and judgement over numbers (ledger ruling) |
| 12.2 | granite end to end driven by a scratchpad `.mjs` instead of `printf … \| node` | The worktree guard rejects compound commands on scratchpad paths |
| 13.2–13.4, 13.1 | Run before 12.1 finished, with `TBD-12.1` markers, then one fill batch | Overlapped the harrier-0.6b cold index (35.5 min) |
| 13.4 (new) | `docs/guide/embedding-models.md`: choosing, configuring, switching, thresholds, benchmarks | Owner's request during the cycle |
| 13.2 | `semantic-backend.md` says the `index` hint does **not** carry `--model` | The plan assumed it did; the code doesn't |
| Final review | One fix wave: ADR no longer settles the EN decision; mermaid label; RSS range 1.3–1.6 GB; rescale warning for explicit thresholds; spec wording; `--stats` ceiling note; one-model claim dropped from the `expansion_floor` description | Final whole-branch review (Opus) |

## 4. Skill / workflow compliance

| Skill | Used |
| ----- | ---- |
| superpowers:brainstorming | ✓ (earlier in the change; `brainstorm.md`) |
| superpowers:writing-plans | ✓ (earlier; reconciled at PR 4 start, `47f61bf`) |
| superpowers:using-git-worktrees | ✓ (worktree created with `git worktree add` + `EnterWorktree`) |
| superpowers:subagent-driven-development | ✓ (ledger in the session scratchpad; per-task review; final review on Opus) |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN evidence in each code task's report: 11.0, 11.1, 11.2, 11.3, 12.1) |
| (transitive) superpowers:requesting-code-review | ✓ (9 task reviews, 4 re-reviews, 1 final) |
| superpowers:systematic-debugging (plan 12.2: "if either MRR misses") | ✗ (not loaded as a skill) |
| superpowers:finishing-a-development-branch | ✓ at 14.4 (after this retro and archive) |

### Deliberately Skipped Skills

**superpowers:systematic-debugging — the EN MRR miss in 12.1/12.2**

- **What was skipped**: Loading the skill when harrier-270m's EN MRR came in at 0.786 (`calibration.md` § harrier-270m). The diagnosis followed its shape: a hypothesis, a probe, the evidence and a conclusion. The checklist itself was not run.
- **Why this cycle**: The first observation already split the hypothesis space. UA reproduced the bake-off to within 0.001 on the same code path, so the plan's three suspects (query prefix, EOS, mask pooling) were ruled out before any debugging began, and the gap was one query on n = 4. A single probe of stored vs fresh vectors answered the one remaining question. The full skill would have re-examined the three ruled-out causes.
- **How to prevent recurrence**: a **scope-judgement rule** for the plan text, not a schema fix. An acceptance step that says "if X misses, run systematic-debugging" should first check whether a sibling metric on the same code path reproduces its reference. If it does, the miss is data until shown otherwise: run one differential probe and record it. The 12.2 text could say exactly that.

## 5. Surprises

- [evidence: `calibration.md` § unranked baseline] bge's `fallback` and `expansionFloor` cut nothing at all, even against every note in the vault. They were effectively off from the start. On bge the fallback retry has always been "return whatever ranks".
- [evidence: `calibration.md` § granite-97m] granite's scale is narrow and high: every query↔note similarity lies in 0.652–0.924. Its `fallback` (0.65) sits only 0.01 under `deep` (0.66), so on this vault the retry and the deep floor are nearly the same filter. harrier-270m spreads over 0.10–0.75, the opposite shape.
- [evidence: `c87feb1`] The live vault had not changed since PR 3's capture: same `vault_sha`, and the copy's bge corpus reconciled with 0 of 949 notes re-embedded. The plan's worry that the baseline was "unrecoverable" proved true only in the sense that mattered: the profile is gone, but the vault state was identical.
- [evidence: `calibration.md` cost table] harrier-270m peaked at 1.3–1.6 GB while indexing, below the "~2 GB" in the design and the commit footer. That figure came from the bake-off's measuring script, which held the whole corpus and token statistics in memory.
- [evidence: final review item 5] `--stats` builds `note_all` as N·(N−1) numbers in a plain array. That is fine at 888 notes, and a hard `RangeError` at about 11.6k. A calibration tool that silently fails only on a big vault was not on anyone's list.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A fresh worktree needs `npm ci` before its first commit**: otherwise lint resolves the parent checkout's `node_modules` and the type-aware rules fail on `any`.
  → **Promote to** memory (feedback)
  > **Why**: the first commit in `.claude/worktrees/emp-pr4` failed the pre-commit hook with `no-unsafe-call` / `no-unnecessary-type-assertion` on untouched files. Node resolution walked up to the main checkout's install, so types didn't line up. `npm ci` in the worktree fixed it.
  > **How to apply**: right after creating a worktree with `git worktree add` (not via the app), run `npm ci` in it before any lint, test or commit. If the hook fails on files the change never touched, suspect this first.

- [ ] 🟡 **Probe the data a design decision rests on before committing the decision**: for calibration rules, read the baseline's population extremes before writing the matching rule.
  → **Promote to** memory (feedback), linked to [[feedback_probe_exact_gate_command]]
  > **Why**: D11's unranked-population decision (`9f453df`) tripped its own stop rule on the first measurement. Two bge defaults sat below the new populations' minima, which one `quantiles()` call on the existing corpus would have shown. The owner was asked twice, once in jargon.
  > **How to apply**: before writing a design rule that maps old thresholds onto new data (quantile matching, pass-rate matching), compute each old threshold's position against the new population's min/max on data already at hand. Put any threshold that falls outside the data to the owner as part of the decision itself.

- [ ] 📌 **Docs subagents get one numbers file and a reviewer rubric where an invented number is Important**: "never invent" in the brief alone isn't enough.
  → **Promote to** memory (feedback), linked to [[feedback_verify_code_claims_in_durable_docs]]
  > **Why**: two of three docs dispatches produced figures that weren't in `numbers.md` (`b70ea2a`, `d68e9de`), and one ADR settled an open owner decision. Only the rubric line caught them.
  > **How to apply**: when docs need measured numbers, write them to one file, tell the implementer it's the only allowed source, and give the reviewer the same file with "an untraceable number = Important". Tell ADR authors explicitly which decisions are still the owner's.

- [ ] 📌 **An acceptance bar on n ≤ 5 queries needs a tolerance or a bigger slice**: EN MRR ≥ 0.8 on 4 queries flips on one rank.
  → **Promote to** one-off (golden-set curation, #86), since the general fix is a bigger EN slice, which the bake-off already recommended
  > **Why**: the bake-off cleared the bar by one rank (0.812). This cycle missed it by one rank (0.786) with no code cause.
  > **How to apply**: when a design sets an MRR bar on a slice with n ≤ 5, state the bar as "no more than one query worse than the reference" or grow the slice first.
