# Verification Report

> 此檔案由 `openspec-verify-change` skill 在 apply 完成後產生，用以確認實作
> 與 specs / design / tasks 的一致性。

**Change**: `retrieval-eval-harness`
**Verified at**: `2026-08-25 15:55`
**Verifier**: Claude (opsx apply session, worktree `retrieval-eval-harness`, branch `feat/retrieval-eval-harness`)

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] 全數 items `"valid": true`

**結果**：

```text
17 / 17 valid (0 failures) — 1 change, 16 specs
```

Only INFO-level notes, both on the new `retrieval-eval` delta spec: `requirements[0]`
and `requirements[3]` exceed 500 characters. Both are deliberately dense contract
statements (golden-set schema; positions-only scoring with all three metric
definitions) and read better whole than split. Non-blocking.

---

## 2. Task Completion (`tasks.md`)

- [x] 所有 `- [ ]` 已變為 `- [x]` (14/14)

**未完成任務**：無。

| Task | 未完成原因 | 是否阻塞 archive |
|---|---|---|
| — | — | — |

Note on `plan.md`: its per-step checkboxes were left unticked by the implementers.
`tasks.md` is this schema's tracked artifact and it is complete; the plan's step boxes
are working notes, not a tracked surface. No `[~]` deferred rows exist in `plan.md`
(see §7).

---

## 3. Delta Spec Sync State

| Capability | Sync 狀態 | 備註 |
|---|---|---|
| `retrieval-eval` | ✗ 待 sync | 新 capability；`openspec/specs/retrieval-eval/` 尚不存在 — archive 步驟會建立並 sync |

---

## 4. Design / Specs Coherence Spot Check

| 抽樣項 | design 描述 | specs 對應 | 差距 |
|---|---|---|---|
| D1 golden set at a fixed vault path | runner in `eval/`, results gitignored, golden set at `<vault>/.neuro-vault/eval/golden.yaml` | Req "Golden set location and schema" + scenario "Golden set resolved by convention" | 無 |
| D2 YAML list, binary relevant set | `{id, query, lang, source, relevant}`; any relevant path counts | same Req, schema clause | 無 |
| D3 two orthogonal axes | `--pipeline` × `--backend`, both in the report | Req "Orthogonal run axes" (both scenarios) | 無 |
| D4 backends share one snapshot shape | `(vaultRoot) => Map<string, SmartSource>`; missing corpus names the remedy | Req "Backend corpus loading" (both scenarios) | 無 |
| D5 positions-only scoring | threshold 0, top-10, production legs reused | Req "Positions-only scoring" + Req "Standalone library execution" | 見下方漂移警告 |
| D6 metrics and slices | precision@3 / MRR / hit@3 over overall / ua / en | Req "Positions-only scoring" (三個 scenario) | 無 |
| D7 paired-comparison identity | `code_sha`, `vault_sha`, `-dirty`, null, config | Req "Comparable JSON reports" (both scenarios) | 無 |
| D8 path validation is a startup gate | fail before embedding, list every offender | Req "Relevant-path validation gates the run" (both scenarios) | 收緊，見下 |

**漂移警告**（非阻塞）：

1. **D5 vs the shipped `fused` leg — the expansion floor is a retained threshold.**
   D5 says eval "counts rank positions only" because production thresholds are
   model-scale-bound, but the fused leg keeps `expansionFloor: 0.35` (the production
   value) while zeroing the query-side threshold. So the expansion leg's membership
   is still similarity-scale-bound. This is faithful to D5's own text (which lists
   "floor 0.35" among the fused knobs) but the rationale sentence overstated the
   result. Resolved by documenting it: `eval/README.md`'s Scoring section now states
   that the query-side threshold is zeroed while the expansion floor is deliberately
   retained, and that `semantic` is the clean cross-model read. The value is also
   echoed in every report's `config.expansion_floor`.

2. **D8 shipped stricter than written.** D8 says "every `relevant` path is checked for
   existence in the vault". The shipped gate checks membership in the *scoped vault
   listing* (`FsVaultReader.scan()`), not `fs.access`. That is stricter in three ways
   the spec's intent wants: it is case-exact (this project's user is on a
   case-insensitive volume, where `fs.access` accepted `Notes/Foo.md` for
   `Notes/foo.md` — a permanently unwinnable query), it excludes scope-excluded notes
   that can never be ranked, and it rejects paths escaping the vault root. Strictly a
   better implementation of the requirement's stated purpose; no spec edit needed.

3. **The fused pipeline omits production's `filterExisting` staleness guard.**
   `search_notes` drops corpus paths that no longer exist on disk before fusing;
   the harness does not. Deliberate: the spec's reuse requirement names the fusion
   function and the leg functions, and `filterExisting` is neither. Documented in
   `eval/README.md` with its consequence — a comparison is only valid when both
   corpora are freshly built against the same vault state.

---

## 5. Implementation Signal

- [x] 所有程式碼變更已 commit
- [x] Branch 為 local；push 於 PR 步驟進行

**Commit 範圍**：`e6ce3d9..3df1c4c` (15 commits)

At the time of writing the only uncommitted path is
`openspec/changes/retrieval-eval-harness/` itself — this cycle's artifacts, which are
committed together with verify.md, retrospective.md and the archive move in the
delivery commit that follows.

Gate evidence, run by the controller from the worktree root after the final fix wave:

```text
npm test        → 1220 passed (101 files), 0 failed
npm run lint    → eslint clean
npm run typecheck → tsc --noEmit clean
npm run build   → tsup + DTS build success
```

Baseline before the change was 1178 tests; the harness added 42.

---

## 6. Front-Door Routing Leak Detector（warning，非阻塞）

- [x] 無檔案

`ls docs/superpowers/specs/*.md` returns no matches.

| 檔案 | 內容是否已 captured 進 change | 建議動作 |
|---|---|---|
| — | — | — |

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains **no `[~]` rows**, so this section is not required. One manual step
is recorded here anyway, because it is a real deferral even though it was never marked
with `[~]`:

| Deferred dogfood (plan §) | Equivalent automated test | Coverage assessment | 真正 gap? |
|---|---|---|---|
| Task 7 Step 5 — `npm run eval -- --vault <real vault> --pipeline semantic --backend own` | `test/eval/run.test.ts` "runs semantic × own and writes a correct report" + "fused × own also completes on the fixture" | CLI parse → golden validation → own-corpus decode → ranking → scoring → report write, end to end over a real temp vault and real shard files. **Not** covered: the real `EmbeddingService` model path, a real Smart Connections `.smart-env/multi` corpus (`--backend sc`), and `gitSha` against a vault that is a git repo — every automated run uses a stub embedder and a non-git temp vault. | ⚠️ partial — the assembly is covered, the real model / real SC corpus / real vault-git path are not |

**Follow-up recorded in the retrospective**: the user runs the harness once against the
real vault before merge. It is the only check that exercises the real embedding model
and a real vault repository, and it costs one command.

---

## Overall Decision

- [x] ⚠️ PASS WITH WARNINGS — 可進入後續步驟但需注意：the three non-blocking coherence
      warnings in §4 (all documented in `eval/README.md`, none requiring a spec edit),
      and the §7 partial coverage gap, which the manual smoke run closes.

**下一步**：

retrospective.md → `openspec archive -y` → `gh pr create` (PR body carries `Closes #84`).
Before merging, run once against the real vault:

```bash
npm run eval -- --vault <path> --pipeline semantic --backend own
```

Either a summary plus a report file, or an honest `GoldenSetError` (the golden set is
curated separately under #86) proves the real CLI path.
