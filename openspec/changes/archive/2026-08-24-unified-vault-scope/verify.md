# Verification Report

> 此檔案由 `openspec-verify-change` skill 在 apply 完成後產生，用以確認實作
> 與 specs / design / tasks 的一致性。失敗的檢查須返回對應 artifact 修正後
> 再重跑 verify。

**Change**: `unified-vault-scope`
**Verified at**: `2026-08-24 14:45`
**Verifier**: Claude Opus 5 (opsx apply controller, subagent-driven-development)

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] 全數 items `"valid": true`

**結果**：

```text
Totals: 13 passed, 0 failed (13 items)
✓ spec/baseline · spec/corpus-staleness-filtering · spec/headless-vault-operations
✓ spec/hybrid-search · spec/mcp-tool-surface · spec/multi-vault-dispatch
✓ spec/read-notes-content-modes · spec/tolerant-arguments · spec/tool-response-envelope
✓ spec/type-aware-linting · spec/vault-conventions-delivery
✓ change/restore-list-properties · change/unified-vault-scope
JSON check: all items "valid": true
```

無失敗項目。

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [x] 所有 `- [ ]` 已變為 `- [x]` (11/11 complete, 0 remaining)

**未完成任務**（若有）：

| Task | 未完成原因 | 是否阻塞 archive |
|---|---|---|
| — | — | — |

---

## 3. Delta Spec Sync State

| Capability | Sync 狀態 | 備註 |
|---|---|---|
| `vault-scope` | ✗ 待 sync | New capability — `openspec/specs/vault-scope/` does not exist yet. `openspec archive` will create it from the delta's ADDED requirements. |
| `headless-vault-operations` | ✗ 待 sync | `openspec/specs/headless-vault-operations/spec.md:97` still carries the pre-change wording of "Tag and property listings aggregate from the vault scan" (no scope notion). The delta's MODIFIED version adds the scoped-scan clause and the out-of-scope scenario. `openspec archive` will apply it. |

Both are the expected pre-archive state, not defects: sync is the archive step's job.

---

## 4. Design / Specs Coherence Spot Check

| 抽樣項 | design 描述 | specs 對應 | 差距 |
|---|---|---|---|
| D2 exclusion layering | three layers merged by union: dot-segments (non-configurable) → `Templates/` + root `.gitignore` → config globs | `vault-scope` R2 (dot-paths always excluded), R3 (built-in defaults), R4 (config union, "SHALL NOT be able to remove a default exclusion") | 無 |
| D3 two views | `ignorePatterns` for fast-glob + `isExcluded` picomatch predicate; the two agree | `vault-scope` R1 — wording tightened during the fix wave to state what the code actually guarantees (predicate authoritative; pattern view never stronger; dot rule predicate-only) | 已於 fix wave 修正，原文 "agree on membership for every path" 對 dot-path 字面不成立 |
| D4 gitignore subset | root file only; skip blank/`#`/`!`; strip trailing slash; entry + `/**`; root-anchored | `vault-scope` R3 states the subset verbatim, plus the negation-ignored and no-gitignore scenarios | 無 |
| D5 config failure contract | missing → silent; unreadable / invalid JSON / invalid shape → stderr warning naming the vault + defaults, server keeps serving | `vault-scope` R4 final sentence + its three scenarios | 無 |
| D7 discovery-not-ACL | `read_notes` by explicit path bypasses scope | `vault-scope` R5 + its scenario | 無 |
| headless delta | tag/property listings aggregate from the **scoped** scan | `headless-vault-operations` MODIFIED requirement + "An out-of-scope note contributes no tags or properties" scenario | 無 |

**漂移警告**（非阻塞）：

- D3 中「fast-glob 的 `ignore` 內部就是 picomatch，兩個 view 因此 by construction 一致」在字面上不成立：predicate 用的是直接依賴 `picomatch@^4`，fast-glob 的 `ignore` 走的是 `micromatch` 底下巢狀的 `picomatch@^2`，是不同 major 的不同 engine。實際一致性來自 predicate post-filter 最後才跑、且 `ignorePatterns` 永遠不會比 `isExcluded` 更強。此點已在 fix wave 於 `docs/architecture/vault-scope.md` 據實改寫；design.md 保留原始決策紀錄（design 是當時的推理，不回改）。

---

## 5. Implementation Signal

- [x] Worktree 內無未 staged 的檔案（`git status --short` 只剩 `?? openspec/changes/unified-vault-scope/`，即本 change 的 artifact 目錄，將於 archive 時一次提交）
- [ ] 所有相關 commit 已推送 — 尚未推送，PR 於 finishing-a-development-branch 階段開立

**Commit 範圍**：`40ba2b0..0145118`（11 commits，branch `worktree-unified-vault-scope`）

Repo gates at HEAD:

```text
npm test          1056 passed (85 files)
npm run lint      eslint clean
npx tsc --noEmit  clean  (authoritative)
npm run build     tsup + DTS success
```

Baseline before the change was 1019 tests; the suite grew by 37 and nothing was removed.

---

## 6. Front-Door Routing Leak Detector（warning,非阻塞）

- [x] 存在的檔案是 schema 安裝前的合法存留

**洩漏清單**：

| 檔案 | 內容是否已 captured 進 change | 建議動作 |
|---|---|---|
| `docs/superpowers/specs/2026-04-*.md` 等既有檔案 | N/A — 皆為 OpenSpec 導入前的凍結紀錄（`AGENTS.md` / `docs/workflow.md` 明載該目錄為 FROZEN pre-OpenSpec record） | 無動作。本 cycle 未新增任何檔案到該目錄 |

本 cycle 的 brainstorm 產出正確落在 `openspec/changes/unified-vault-scope/brainstorm.md`，無新洩漏。

（附註：該目錄本身正是本次行為變更的實例 —— 它被 vault root `.gitignore` 命名，因此在新 scope 下離開 lexical discovery。）

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

plan.md 中沒有任何 `[~]` deferred 標記（`grep -c '\[~\]' plan.md` → 0），本節依判讀規則留白即 PASS。

| Deferred dogfood (plan §) | Equivalent automated test | Coverage assessment | 真正 gap? |
|---|---|---|---|
| — | — | — | — |

---

## Overall Decision

- [x] ✅ PASS — 可進入 finishing-a-development-branch 與 archive

**下一步**：

寫 `retrospective.md`，然後 `openspec archive -y`（會建立 `openspec/specs/vault-scope/` 並把
`headless-vault-operations` 的 MODIFIED requirement 同步進主 spec，同時把 change 目錄搬到
`openspec/changes/archive/2026-08-24-unified-vault-scope/`），最後以
superpowers:finishing-a-development-branch 開 PR。

**PASS 但值得在 PR 描述中點名的一件事**：本 change 帶有刻意的行為變更 —— vault root
`.gitignore` 命名的路徑與 `Templates/` 會離開 lexical discovery（search、`query_notes`、
tag/property listings、overview counts、backlinks、name resolution）。`read_notes` 以明確
路徑讀取不受影響。為了讓這件事真的到得了使用者眼前，`feat` commit 的 subject 已改寫為
`feat(vault-scope): exclude Templates/ and gitignored paths from note discovery` —— 本 repo 的
`commit-and-tag-version` 只從 commit subject 產 CHANGELOG，寫在 `docs:` commit body 裡的說明
不會被渲染。
