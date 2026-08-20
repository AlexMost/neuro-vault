# Verification Report

**Change**: `unify-retrieval-pipeline`
**Verified at**: `2026-08-20 14:5x`
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
✓ change/unify-retrieval-pipeline
✓ spec/vault-conventions-delivery
Totals: 10 passed, 0 failed (10 items)
```

| Item | Type | Issues |
| ---- | ---- | ------ |
| —    | —    | none   |

---

## 2. Task Completion (`tasks.md`)

- [x] 所有 `- [ ]` 已變為 `- [x]` — 35/35

| Task | 未完成原因 | 是否阻塞 archive |
| ---- | ---------- | ---------------- |
| —    | —          | —                |

Task 5.6 (push + `gh pr create`) is ticked as part of the finishing step that
immediately follows this report.

---

## 3. Delta Spec Sync State

| Capability      | Sync 狀態  | 備註                                                                                                             |
| --------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `hybrid-search` | ✗ 待 sync | One ADDED requirement ("Semantic retrieval is arity-invariant", 4 scenarios). `openspec archive` performs the sync. |

`openspec/specs/hybrid-search/spec.md` currently carries 17 requirements; the
delta adds an 18th. No MODIFIED or REMOVED requirements — observable behaviour
is unchanged by this change, so no existing requirement needed rewording.

---

## 4. Design / Specs Coherence Spot Check

| 抽樣項                        | design 描述                                                                     | specs 對應                                                                  | 差距 |
| ----------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| D1 one entry point            | one export taking `queries: string[]`, single query is the degenerate case      | Requirement's opening SHALL — arity is a surfacing concern, not a retrieval one | none |
| D3 one node type              | `matched_queries` always computed                                               | Scenario 2 "arity changes only which fields surface"                        | none |
| D4 tool layer decides surfacing | policy always computes, `isMulti` gates emission                                | Scenario 2's "the string response carries neither key"                      | none |
| D5 pin arity-invariance       | a behaviour-level requirement so the two pipelines cannot regrow                | the requirement itself                                                       | none |

**漂移警告**（非阻塞）：

- Scenario 4 ("leg-level pool truncation is reported identically at both
  arities") is genuinely enforced, but at the **policy layer**
  (`test/semantic/retrieval-policy.test.ts:831`, `describe.each(arities)`,
  truncated true at `:892` / false at `:911`), not at the MCP layer. The
  tool-layer comparison `expect(asArray.truncated).toBe(asString.truncated)`
  (`search-notes-hybrid.test.ts:844`) is vacuous in its fixture — both sides are
  `false`. The requirement holds and is tested; the redundant MCP-level
  assertion adds no signal. Recorded as a follow-up in the retrospective.

---

## 5. Implementation Signal

- [x] Worktree 內無未 staged 的檔案
- [x] 所有相關 commit 已推送 — pushed as part of the finishing step below

**Commit 範圍**：`69adcb5..ffdbc6b` (9 commits)

Project verify gates (`openspec/config.yaml` → `rules.verify`), all run in the
worktree:

| Gate                | Result                    |
| ------------------- | ------------------------- |
| `npm test`          | 977 passed / 78 files     |
| `npm run lint`      | clean                     |
| `npx tsc --noEmit`  | clean (typecheck SoT)     |

Additional acceptance checks from plan §5:

| Check                                             | Result                                        |
| ------------------------------------------------- | --------------------------------------------- |
| `retrieval-policy.ts` line delta                  | 20 insertions / **159 deletions** (net −139)  |
| contract leak into `search-notes.ts`              | none (`SearchNotesOutput` / `inputSchema` / `z.`) |
| scratch artifact in any branch commit             | 0 occurrences of `__scratch__`                |

---

## 6. Front-Door Routing Leak Detector（warning，非阻塞）

- [x] 無檔案，或存在的檔案是 schema 安裝前的合法存留

`ls docs/superpowers/specs/*.md` returns 36 files. All predate the
superpowers-bridge schema install and are the repo's **frozen pre-OpenSpec
record** — `AGENTS.md` and the routing rules both name that directory as frozen,
and this change deliberately did not write to or edit it (the docs sweep in
Task 4 explicitly excluded it).

| 檔案                            | 內容是否已 captured 進 change | 建議動作                            |
| ------------------------------- | ----------------------------- | ----------------------------------- |
| `docs/superpowers/specs/*` (36) | N/A — pre-schema historical   | none; frozen record, leave untouched |

This change's own brainstorm output went to
`openspec/changes/unify-retrieval-pipeline/brainstorm.md` as the schema requires.
No new leak.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains zero `[~]` deferred rows — every task was executed in this
cycle. Section intentionally blank per the template's rule.

| Deferred dogfood (plan §) | Equivalent automated test | Coverage assessment | 真正 gap? |
| ------------------------- | ------------------------- | ------------------- | --------- |
| —                         | —                         | —                   | —         |

---

## Overall Decision

- [x] ⚠️ PASS WITH WARNINGS — 可進入後續步驟但需注意：the §4 drift note. Spec
      scenario 4 is enforced at the policy layer rather than the MCP layer; the
      tool-layer assertion intended to cover it is vacuous in its fixture. The
      requirement is genuinely tested, so this does not block archive, but the
      redundant assertion should either be given a truncating fixture or removed
      rather than left looking like coverage it does not provide.

**下一步**：

Retrospective, then `openspec archive`, then
`superpowers:finishing-a-development-branch` to push and open the PR.

Verification beyond the schema's checks, recorded here because it is the
evidence the change rests on:

- The equivalence premise was proved **before** any code moved, by a
  differential harness (8 cases, git-excluded, deleted at Task 3 Step 12) that
  ran a verbatim copy of the old single-query body against the surviving
  pipeline. The controller mutation-tested it (disabled the multi backfill →
  RED; revert → GREEN) rather than trusting a green run.
- The MCP contract guard was written against the **unmodified two-pipeline
  code** and committed before the fold (`6e91203`), so it could contradict the
  refactor rather than describe it. Both contract gates were mutation-tested
  post-fold by the reviewer.
- The strongest behaviour-preservation evidence was incidental:
  `test/semantic/calibration-curve.test.ts` holds full-precision inline
  snapshots of retrieval output. Stripping `"matched_queries":["q"],` from the
  two updated single-query snapshots yields a byte-identical diff against the
  pre-change versions, and the multi-query snapshot required no change at all.
