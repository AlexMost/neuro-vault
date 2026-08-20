# Verification Report

**Change**: `vault-conventions-delivery`
**Verified at**: `2026-08-20 11:2x`
**Verifier**: Claude Opus 5 (controller session, fallback path — `openspec-verify-change` skill not installed; the numbered checks below were run manually per the schema's documented fallback)

---

## 1. Structural Validation (`openspec validate --all`)

- [x] 全數 items `"valid": true`

**結果**：

```text
✓ spec/baseline
✓ spec/headless-vault-operations
✓ spec/hybrid-search
✓ spec/mcp-tool-surface
✓ spec/read-notes-content-modes
✓ change/restore-list-properties
✓ spec/tolerant-arguments
✓ spec/tool-response-envelope
✓ change/vault-conventions-delivery
Totals: 9 passed, 0 failed (9 items)
```

| Item | Type | Issues |
|---|---|---|
| — | — | none |

---

## 2. Task Completion (`tasks.md`)

- [x] 所有 `- [ ]` 已變為 `- [x]` — 29/29

| Task | 未完成原因 | 是否阻塞 archive |
|---|---|---|
| — | — | — |

Note: task groups 3+4 and 6+7 were each executed as a **single commit** rather than
two. Both plans instructed committing while `tsc --noEmit` was red, with the following
task repairing it; that contradicts the change's own Global Constraint that all gates
pass before any commit. The constraint governs, so the pairs were merged. Every task's
substance was delivered.

Task 5 (manual end-to-end verification) carries no commit by design — it is a
verification step, not a code change. Its evidence is in §7.

---

## 3. Delta Spec Sync State

| Capability | Sync 狀態 | 備註 |
|---|---|---|
| `vault-conventions-delivery` | ✗ 待 sync | New capability — `openspec/specs/vault-conventions-delivery/` does not exist yet. `openspec archive` performs the sync. Expected state at this point. |

---

## 4. Design / Specs Coherence Spot Check

| 抽樣項 | design 描述 | specs 對應 | 差距 |
|---|---|---|---|
| Field naming | D4: `conventions`, `conventions_truncated`; `agent_instructions` rejected | Req “get_vault_overview carries the vault's conventions” | 無 |
| Both surfaces from one compute | D5: compute layer, not per-adapter | Same req: “produced by the shared overview computation so that both surfaces … keep one response shape” | 無 |
| Absent, not empty | D8 / spec | Req “The conventions field is absent rather than empty” | 無 |
| Per-call freshness | D7: read at call time, no cache | Req “Conventions are read at call time” | 無 |
| Soft cap + visible flag | D8: cap 8000, `previewBody` idiom | Req “Oversized conventions are truncated visibly” | Spec wording corrected mid-cycle: the slice is bounded at the cap **plus a one-character truncation marker**, matching `capConventions`. |
| Ordering + budget | D2/D3 | Req “A vault's conventions survive the instructions truncation budget” | 無 |
| Delivery-channel principle | D11 → ADR-0010 | — (ADR, not a spec requirement) | 無 |

**漂移警告**（非阻塞）：

- **D8's cap rationale was factually wrong and has been corrected in `design.md`.** It
  claimed 8,000 was “roughly 6× a typical ~1,200-character conventions file, so trimming
  should be rare”. Measured against the vault actually in use, the file is **6,755
  characters — 84% of the cap**. Raising the cap was offered and declined; it now stands
  as deliberate back-pressure toward compact conventions, and the doc records this.
- **D3 over-generalised the multi-vault rehoming** (“`describeMultiVault` already appends
  to every multi-vault-aware description”). False in two ways: `search_notes` never calls
  it, and 9 of 14 tools carry the *opposite* contract (`VAULT_REQUIRED`). Corrected in
  `design.md` and in ADR-0010.

---

## 5. Implementation Signal

- [x] Worktree 內無未 staged 的檔案（this report and the ticked `tasks.md` are committed together)
- [x] 所有相關 commit 已推送

**Commit 範圍**：`d6b1333..4e40ae4` (10 commits)

Repo-wide gates on `4e40ae4`, all independently re-run by the controller:

| Gate | Result |
|---|---|
| `npm test` | **945 passed / 78 files** (baseline before the branch: 915 / 76) |
| `npm run lint` | clean |
| `npx tsc --noEmit` | exit 0 |
| `prettier --check .` | clean |

User-facing reference updated in the same change (schema rule): `README.md`,
`docs/guide/configuration.md`, `docs/guide/reading-and-modifying.md`,
`docs/guide/installation.md` — this change alters `get_vault_overview`'s output shape and
16 tool descriptions.

---

## 6. Front-Door Routing Leak Detector（warning,非阻塞）

- [x] 存在的檔案是 schema 安裝前的合法存留

`docs/superpowers/specs/` holds 36 files dated 2026-04-10 → 2026-06-08, i.e. the frozen
pre-OpenSpec record that `AGENTS.md` explicitly documents as read-only history. This
cycle wrote **nothing** there: its brainstorm went to
`openspec/changes/vault-conventions-delivery/brainstorm.md` as the schema requires.

| 檔案 | 內容是否已 captured 進 change | 建議動作 |
|---|---|---|
| (36 pre-existing files, 2026-04 → 2026-06) | N/A — predate this change and the schema install | 保留 |

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains **zero** `[~]` rows — no manual check was deferred. Section is
therefore not required to be filled.

Recorded for completeness: the one manual dogfood in the plan (Task 5) **was executed**,
not deferred, against the real vault at `/Users/amostovenko/Obsidian`:

| Manual check | Result | Equivalent automated coverage |
|---|---|---|
| `conventions` matches the on-disk file | ✅ 6,755 chars, exact match | `test/operations/tools/get-vault-overview.test.ts` (stubbed reader) |
| `conventions_truncated` absent under the cap | ✅ absent | `test/lib/obsidian/vault-overview.test.ts` boundary cases |
| Edit between two calls visible **without restart** | ✅ 6,755 → 6,818 chars | `vault-overview.test.ts` “re-reads on every call” (closure mutation between two computes) |
| Vault file left byte-identical | ✅ sha256 matched pre-test backup | N/A (test-hygiene check) |

---

## Overall Decision

- [x] ✅ PASS — 可進入 finishing-a-development-branch 與 archive

**下一步**：

Produce `retrospective.md`, then `openspec archive -y` to sync the delta spec into
`openspec/specs/vault-conventions-delivery/` and move this folder under
`openspec/changes/archive/`. The PR then carries the complete cycle.

Final whole-branch review (opus, `d6b1333..4e40ae4`) returned **“Ship it”** — no Critical
or Important findings. Five Minors were triaged as ship-as-is; the actionable one
(unticked `tasks.md` boxes) is fixed above. The remaining four are carried into the
retrospective as follow-ups:

1. `buildServerInstructions` calls `readConventions()` without the try/catch its sibling
   overview path has. Behaviourally safe today only because the production reader
   swallows everything — the two channels are asymmetrically defended for one contract.
2. The `instructions` channel applies no size cap (documented boundary, unchanged
   pre-branch behaviour).
3. The tag-query recipe (`{ filter: { tags: '<name>' } }`) is the one audited deletion
   with no literal description home; derivable in one hop from `list_tags` +
   `query_notes`, so not lost.
4. The `vault://overview` resource description does not carry the authority sentence that
   `get_vault_overview`'s does.
