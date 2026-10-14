# Verification Report

**Change**: `per-model-corpus`
**Verified at**: `2026-10-14 22:58`
**Verifier**: Claude Opus 5.5 (apply controller), with a read-only scenario-coverage subagent

---

## 0. Repo gates (`openspec/config.yaml` → `rules.verify`)

| Gate | Result |
|---|---|
| `npm test` | 1666 passed, 4 skipped (125 files) — baseline 1560 passed at `0b28012`, +106 |
| `npm run lint` | clean (exit 0) |
| `npx tsc --noEmit` | clean |
| User-facing reference for the changed CLI surface | `README.md`, `docs/guide/{installation,configuration,embedding-models}.md`, `docs/architecture/{own-corpus,cli-startup,semantic-backend,embedding-pipeline}.md`, `eval/README.md` updated; no MCP tool schema changed |

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] 全數 items `"valid": true`

**結果**：

```text
totals: items 20, passed 20, failed 0 (change 1/1, spec 19/19)
```

---

## 2. Task Completion (`tasks.md`)

- [x] 所有 `- [ ]` 已變為 `- [x]` (5.2 — verify → retrospective → archive → PR — is checked when this report is written; its remaining steps run next)

---

## 3. Delta Spec Sync State

| Capability | Sync 狀態 | 備註 |
|---|---|---|
| own-corpus-index | ✗ 待 sync | synced by `openspec archive` |
| cli-index-command | ✗ 待 sync | synced by `openspec archive` (includes the scenario added in the final fix wave: the kept model's corpus vanished before the prune) |
| retrieval-eval | ✗ 待 sync | synced by `openspec archive` |
| semantic-backend-lifecycle | ✗ 待 sync | synced by `openspec archive` |

---

## 4. Design / Specs Coherence Spot Check

Scenario coverage (11 requirements, 58 scenarios): **50 covered by a test, 8 implemented without a direct automated test, 0 missing.**

| 抽樣項 | design 描述 | specs / code 對應 | 差距 |
|---|---|---|---|
| D1/D2 layout | `corpus/<model_key>/`, name rule, reserved names | `layout.ts`, `CorpusStore` requires `modelKey`; `layout.test.ts`, `shard-store.test.ts` | none |
| D3/D4 migration | rename notes then manifest, under the lock | `legacy-migration.ts`, `reconcile.ts`; `legacy-migration.test.ts`, reconcile call-order test | none |
| D5 lock | exclusive create, host/pid/token, 50 ms→2 s, 30 min, 1 s grace | `reconcile-lock.ts`; `reconcile-lock.test.ts` (incl. grace per file, conditional unlink, release warn) | first consecutive vanished-lock read retries at once, later ones back off (design D5 updated in `bf92d7a`) |
| D7 server | reload after wait; timeout keeps state, re-arms | `corpus-backend.ts`; five backend tests | none |
| D8 prune | after reconcile, under lock, sorted report | `prune.ts`, `cli-index.ts`; prune + cli tests | refuses when the kept corpus has no manifest (design D8 + spec scenario updated) |
| D10 eval | per-model dir, names others, read-only | `eval/backends.ts`; backends tests | none |

**漂移警告**（非阻塞）：

- Scenarios implemented but without a direct automated test (all exercised by the manual check in §7 or by lower-level tests): own-corpus-index "Two models keep separate corpora" (store-level only); cli-index-command "Cold index builds the corpus", "A selected profile builds the corpus", "Switching profiles is not a rebuild" (CLI tests stub `reconcile`); retrieval-eval "Comparing two models keeps both corpora" (sequence untested; each half tested); semantic-backend-lifecycle "An incompatible corpus is rebuilt, not served", "Another model's corpus is left alone", "Disposal stops the wait" (pieces tested separately).
- `prune.ts` leaves a symlinked entry under `corpus/` alone (plan Review Focus 4, tested); design D8 says "every directory" without naming symlinks.
- `reconcile.ts` returns the empty summary for any acquisition error once the pass's signal is aborted (a shutdown), not only for the abort itself.

---

## 5. Implementation Signal

- [x] Worktree 內無未 staged 的檔案 (only this report and `tasks.md`, committed with it)
- [ ] 所有相關 commit 已推送 — pushed with the PR (next step)

**Commit 範圍**：`0b28012..bf92d7a` (18 commits; 39 files, +2583/−176; src+eval 14 files, +835/−66)

---

## 6. Front-Door Routing Leak Detector（warning,非阻塞）

- [x] 無檔案 (`ls docs/superpowers/specs/*.md` → no matches)

---

## 7. Manual check (plan Task 5.1) and deferred-dogfood equivalence

No plan row is marked `[~]`; the manual check ran in full on 2026-10-14 against the worktree build (`npm run dev`), real processes, real models (`granite-97m`, `harrier-270m`), on a generated 40-note temp vault `pmc-vault` (deleted afterwards).

```text
Task 5.1 manual check — 2026-10-14, worktree build via `npm run dev` (tsx), generated 40-note temp vault `pmc-vault`.

Step 2 — two concurrent `index --model granite-97m`:
  indexed pmc-vault: total=40 embedded=0 reused=40 renamed=0 deleted=0 failed=0
  indexed pmc-vault: total=40 embedded=40 reused=0 renamed=0 deleted=0 failed=0
  stderr (one process only): waiting for another neuro-vault process (pid 7626) to finish with pmc-vault…
  corpus/ afterwards: granite-97m (no reconcile.lock)
Step 3 — legacy root layout (notes/ + manifest.json moved back to corpus/):
  stderr: neuro-vault corpus: moved the granite-97m corpus of vault <scratch>/pmc-vault into .neuro-vault/corpus/granite-97m/ (one corpus directory per model)
  indexed pmc-vault: total=40 embedded=0 reused=40 renamed=0 deleted=0 failed=0
  corpus/ afterwards: granite-97m
Step 4 — second model beside the first:
  index --model harrier-270m: indexed pmc-vault: total=40 embedded=40 reused=0 … failed=0
  granite-97m/manifest.json: OK (shasum unchanged); corpus/: granite-97m harrier-270m
  index --model granite-97m again: indexed pmc-vault: total=40 embedded=0 reused=40 … failed=0
Step 5 — stale lock (this host, pid 999999):
  "waiting for another" lines: 0; corpus/ afterwards: granite-97m harrier-270m (no reconcile.lock)
Step 6 — `--prune` with a leftover legacy notes/ + manifest.json:
  pruned pmc-vault: removed granite-97m, manifest.json, notes
  corpus/ afterwards: harrier-270m
Step 4b — a fresh model directory beside another builds with no `rebuilding` line (re-checked after prune: granite-97m rebuilt fresh beside harrier-270m: embedded=40, no rebuild line, harrier-270m/manifest.json shasum OK).
```

Re-run after the final fix wave (HEAD `bf92d7a`, fresh 40-note vault), all steps as above with the same results (step 2 wait line `pid 29354`; step 5 zero wait lines; step 6 `pruned pmc-vault: removed granite-97m, manifest.json, notes`), plus:

```text
Step 7 — two concurrent `index --prune`, granite-97m and harrier-270m, both corpora present:
  granite run: indexed … embedded=0 reused=40 …; pruned pmc-vault: removed harrier-270m
  harrier run: waiting for another neuro-vault process (pid 29538) to finish with pmc-vault…
               indexed … embedded=40 reused=0 …; pruned pmc-vault: removed granite-97m
  corpus/ afterwards: harrier-270m  (the vault is never left without a corpus)
```

| Manual step | Equivalent automated test | Coverage assessment | 真正 gap? |
|---|---|---|---|
| Two concurrent `index` runs | `reconcile.test.ts` "serialises two passes over one vault…" (real lock file, distinct injected pids) | lock contention, reuse after wait; not two OS processes | ❌ 已等價覆蓋 at library level; the OS-process half is this manual check |
| Legacy layout migrates, embedded=0 | `reconcile.test.ts` "reuses a single-corpus layout after moving it…" | migration under the lock + reuse | ❌ |
| Second model beside the first | `shard-store.test.ts` per-model isolation tests | store isolation; not the full CLI sequence | ✅ partial — CLI-level sequence only manual |
| Stale lock replaced | `reconcile-lock.test.ts` dead-holder / own-pid tests | judgement + replacement | ❌ |
| `--prune` | `prune.test.ts`, `cli-index.test.ts` prune tests (incl. real `defaultPrune` under a held lock) | removal set, skip rules, output | ❌ |

---

## Overall Decision

- [ ] ✅ PASS — 可進入 finishing-a-development-branch 與 archive
- [x] ⚠️ PASS WITH WARNINGS — 可進入後續步驟但需注意：eight scenarios rely on the manual check or lower-level tests rather than a direct automated test (§4); recorded as a retrospective follow-up.
- [ ] ❌ FAIL — 返回失敗的 artifact 修正後重跑 verify

**下一步**：

Write `retrospective.md`, `npx openspec archive per-model-corpus -y`, run the gates plus `npm run build` and commitlint, push, open the PR against `main` with `Closes #146`.
