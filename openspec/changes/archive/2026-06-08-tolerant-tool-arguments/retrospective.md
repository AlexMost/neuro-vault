# Retrospective: tolerant-tool-arguments

> Written: 2026-06-08 (after verify passed)
> Commit range: `1fc73f9..a0d87e8` (branch vs current main)
> Worktree: `.claude/worktrees/tolerant-tool-arguments`

---

## 0. Evidence

- **Commit range**: `1fc73f9..a0d87e8` — 4 feature commits + 2 merge commits + 1 artifacts commit
  - Feature: `cdf0df9` (array coercion), `35735e8` (alias + SDK advertisement/gate fix), `d95264e` (tasks), `27d04bd` (re-point)
- **Diff size**: +298 / −7 across 8 code/test/doc files (openspec artifacts excluded)
- **Tasks done**: 9/9
- **Active hours**: ~1.5h (apply phase)
- **Subagent dispatches**: ~13 — 1 Explore (codebase), 4 implementers (array-coercion, alias, SDK-advertisement fix, SDK-gate fix), 2 spec reviewers, 3 code-quality reviewers, 1 final whole-impl reviewer, 1 adversarial re-reviewer
- **New external dependencies**: none
- **Bugs encountered (pre-merge, caught in review)**: 3 Criticals — all in the alias feature's MCP-SDK integration; all fixed before merge. Zero shipped.
- **OpenSpec validate state at archive**: pass (4/4 items)
- **Test coverage signal**: 717 vitest tests on the merged tree (≈16 net-new from this change after the re-point); my key suites 124/124
- **Commit chain**:

```
3a02dbf docs(openspec): add tolerant-tool-arguments change (proposal through plan)
cdf0df9 feat(coercion): parse stringified arrays for plain-array params
35735e8 feat(query_notes): accept `filters` as an alias of `filter`   [+SDK advertisement & gate fixes, amended]
d95264e docs(openspec): mark tolerant-tool-arguments tasks complete
42944a8 Merge origin/main (read-notes-preview + chores)
27d04bd test: re-point stringified-array boundary demo to get_similar_notes.exclude_folders
a0d87e8 Merge origin/main (audit-underused-mcp-tools)
```

---

## 1. Wins

- **Layered review caught 3 Criticals a green test suite hid.** [§0: 3 Criticals, ~13 dispatches] The two-stage per-task review, the final whole-implementation review, and the adversarial re-review each caught a distinct MCP-SDK integration defect — and every one of them passed `npm test`/`lint`/`tsc` at the time, because the tests exercised `reg.handler` directly instead of the SDK's pre-validation gate. Without the layered review the feature would have shipped broken through the real MCP entry point.
- **Built on the existing coercion seam, minimal surface.** [§0: +298/−7, 8 files] The whole change is additive at `wrapSchemaWithCoercion`/`coerceFieldValue` plus one `inputAliases` declaration — no new dependencies, no error-code or transport changes.
- **Empirical verification at the zod/SDK level.** Each Critical fix was reproduced and confirmed against the real `@modelcontextprotocol/sdk` `normalizeObjectSchema`/`validateToolInput` code paths, not by reasoning alone — which is how the required-field gate edge was eventually pinned down.
- **Isolated file surface made a thrice-moving `main` cheap to absorb.** [§5] The change touches only `input-coercion.ts`, `tool-registry.ts`, `query-notes.ts` + tests; three sibling tasks merged to `main` mid-flight and the only real conflicts were one test file (dropped) and one dictionary row.

## 2. Misses

- 🔴 [blocking | evidence: §0 3 Criticals; the SDK-gate bug survived spec-review + code-review + final-review] The test strategy validated tools via `reg.handler(...)`, which **bypasses the SDK's `validateToolInput` gate** where required-field and unknown-key enforcement actually run. Two of the three Criticals lived precisely in that gap (empty advertised schema; required-`filter` rejected before the alias rename). A passing suite gave false confidence twice.
- 🟡 [painful | evidence: the SDK-advertisement fix verification used an `optional` `filter` fixture] My own empirical check of the first fix used a fixture where the canonical field was `.optional()`, which made the gate pass — a **false-positive green** that masked the required-field bug until the final adversarial review reproduced it with the real (required) schema.
- 🟡 [painful | evidence: §5 two reconciliation merges] The change was authored against a `read_notes` whose `fields` param was removed by a sibling PR mid-flight, invalidating one scope item, three tests and one spec scenario; required a re-point to `get_similar_notes.exclude_folders`.
- 📌 [nit | evidence: §5] The aliased tool's advertised schema is now `additionalProperties: true` and marks `filter` as not-required — a documented, accepted inaccuracy, but a real divergence between advertised and enforced contract.

## 3. Plan deviations

| Plan task | What changed | Why |
| --- | --- | --- |
| 1.2 / design D2 | Alias mechanism grew a second schema builder `wrapSchemaForSdk` (loose object for the SDK, strict pipe for the handler) beyond the planned single top-level `z.preprocess` | The planned pipe is a `ZodPipe`, which the MCP SDK cannot advertise as an object (empty params) and whose `.loose()` form rejects an alias-only call at the required-field gate. Two fixes, both at the central seam. |
| 2.3 | Boundary tests + spec scenario re-pointed from `read_notes.fields` to `get_similar_notes.exclude_folders` | Sibling PR #47 (`read-notes-preview`) removed `read_notes.fields`, replacing it with a `content` enum, while this change was in flight. The coercion branch is generic and unchanged; only the demonstration vehicle moved. |

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ✓ |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review | ✓ |
| superpowers:finishing-a-development-branch | ✓ (final step, in progress) |

### Deliberately Skipped Skills

None — every apply-phase skill was used.

## 5. Surprises

- **One schema serves two masters.** The MCP SDK uses `spec.inputSchema` for BOTH tool advertisement AND its own pre-validation gate (`mcp.js:76` and `:125`). That coupling is why a top-level `z.preprocess` (good for the handler) silently broke advertisement, and why the `.loose()` fix (good for advertisement) broke the required-field gate. Neither was visible from the tool code alone.
- **A 100%-green suite while the headline feature was broken — twice.** Both SDK-path Criticals passed every gate because tests didn't traverse the SDK's `validateToolInput`.
- **`main` moved three times during a single apply** (PRs #47, #48–50, #51 — all sibling neuro-vault tasks), removing a parameter and three whole tools the change had to reconcile against.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **Test MCP tools through the SDK's validation gate, not just the handler** → **Promote to memory** (type: feedback)
  > **Why**: In this change, two Critical bugs (empty advertised schema; required canonical field rejected before an alias rename) survived spec-, code-, and final-review because every test called `reg.handler(...)` directly, bypassing the SDK's `validateToolInput`/`normalizeObjectSchema` path where those failures live.
  > **How to apply**: When testing a neuro-vault MCP tool whose registration wraps the schema (coercion, aliases, advertisement), add at least one assertion that parses raw args against `reg.spec.inputSchema` (the SDK's gate) — not only `reg.handler` — and assert the advertised schema is a `ZodObject` exposing the params.

- [ ] 🟡 **Verify fixes with a fixture that matches the real constraint** → **Promote to memory** (type: feedback)
  > **Why**: My empirical check of the SDK-advertisement fix used an `optional` `filter` fixture; the real param is required, and the optional fixture produced a false-positive green that hid the required-field gate bug for another full review cycle.
  > **How to apply**: When building a throwaway repro to confirm a fix, mirror the production schema's required/optional and type constraints exactly; a relaxed fixture can pass while the real one fails.

- [ ] 📌 **MCP input-schema changes must check the SDK advertisement path** → **One-off** (architecture note)
  > **Why**: Wrapping a tool's schema in any top-level `z.preprocess`/transform turns it into a `ZodPipe` that `normalizeObjectSchema` can't read, silently advertising an empty input schema.
  > **How to apply**: Any future change that wraps `spec.inputSchema` at the top level should keep it a `ZodObject` (or provide a separate object schema for advertisement), and assert advertised params survive.
