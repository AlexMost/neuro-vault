# Verification Report

**Change**: `structural-reads`
**Verified at**: `2026-10-31`
**Verifier**: the controller session that ran the apply phase, with three Haiku probe runs and an
opus grader

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] Every item is `"valid": true`

**Result:** 27 of 27 items valid. The change's four delta specs are included:
`embed-text-extraction`, `hybrid-search`, `read-notes-content-modes` and
`read-notes-selections`.

---

## 2. Task Completion (`tasks.md`)

- [x] Every task through 4.2 is `- [x]`

**Open tasks:**

| Task | Why open | Blocks archive |
|---|---|---|
| 4.3 Verify, retrospective, archive | This report is its first step. It is ticked when the archive commit lands. | No |
| 4.4 Ship PR 4/4 | It runs after the archive. | No |

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
|---|---|---|
| `embed-text-extraction` | ✗ Needs sync | The archive applies the MODIFIED requirement (real-line spans) |
| `read-notes-content-modes` | ✗ Needs sync | The archive applies outline, preview, `lines` on full, and selections under each mode |
| `read-notes-selections` | ✗ Needs sync | A new capability. The archive creates it |
| `hybrid-search` | ✗ Needs sync | The archive applies the MODIFIED description requirement (one hand-off line, cap 4,050) |

`openspec archive structural-reads -y` syncs all four.

---

## 4. Design / Specs Coherence Spot Check

| Sample | Design | Specs | Gap |
|---|---|---|---|
| D2 coordinates | File-relative, 1-based, inclusive, shared with search | Selections: "Line coordinates are file-relative, 1-based, and inclusive" | None |
| D5 collapse | Drop the deepest level past 100 entries; `hidden` counts headings | Content modes: "A large outline collapses by depth". The deepest kept entry carries `hidden` | The plan sentence was corrected to match (ruling R15) |
| D8 clipping | Clip to the body at both ends | Selections: two clipping scenarios | None |
| D10 item shape | Strict item objects; `content` never inside an item | Content-modes scenario: `content` inside an item is `INVALID_PARAMS`, naming the key | Met in PR 3 (fix I1) |
| D11 hand-off | Body rows by `lines`; `---frontmatter---` as a frontmatter read | Selections requirement and scenario; the hybrid-search delta | D11 amended in #257 (F1); one `search_notes` line instead of two (R21) |

**Drift warnings (non-blocking):**

- `brainstorm.md` still says "two RESPONSE SHAPE lines". It is history and is left as written.
- Real MCP clients see the SDK's argument-validation error, not the gate's `INVALID_PARAMS`
  envelope. The SDK validates against `spec.inputSchema` before the handler runs. This predates
  the change and affects every tool, and `docs/guide/configuration.md` claims otherwise. It is
  proposed as a separate follow-up.

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [x] PRs 1–3 merged; PR 4's commits are on `feat/structural-reads-4`

**Commit range:** `fa7b6e1..HEAD`. That covers #256, #257, #258, #259, and this branch from
`c9df2fa`. There were 2,993 tests after PR 1 and 3,211 at the end.

---

## 6. Front-Door Routing Leak Detector

- [x] No files under `docs/superpowers/specs/`

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

| Deferred item | Equivalent automated test | Coverage | Real gap? |
|---|---|---|---|
| Manual Haiku probe of the composed `read_notes` description (Task 4.3) | None. It was run as specified (below) | Model comprehension | ❌ Done manually |
| Corpus rebuild on upgrade (`EMBED_VERSION` 3) | `identity.test.ts` (a v2 manifest mismatches) and the reconcile-loop announcement tests | The identity check and the rebuild trigger | ❌ Covered |
| Bare-path preview byte-identical to before | `read-notes.test.ts`, which pins three bodies against `previewBody` | Content and `truncated` | ❌ Covered |

### Haiku probe (253 probe set)

- **Inputs:**
  - the composed descriptions as registered: `read_notes` at 5,183 characters, `search_notes`
    at 3,584 characters (single-vault);
  - the prototype branch's `probe/fixtures.md` and `probe/questions.md` (Q1–Q17).
- **Runs:** 3 Haiku runs, each reading only those four files.
- **Grading:** an opus grader scored the runs against the implemented behaviour, checked through
  the resolver and the input gate.
- **Score:** 17/17 in all three runs.

**Misreads and fixes.** The runs shared four confusions. All four were fixed in `49a64b2` before
archive:

1. A bare `Notes` matching "the first of `Notes` / `Notes[2]`" read as one name matching two
   blocks, against the `AMBIGUOUS_MATCH` rule. This happened in 3 of 3 runs. The description now
   states the repeat suffix first, and says the insensitive pass runs only when nothing matches
   exactly.
2. "Frontmatter ends on `lines[0] − 1`" is wrong for a selection. The identity is now stated for
   a whole note only.
3. "Always carry parsed `frontmatter`" contradicted `null`. The description now says `null` when
   the note has none or its YAML did not parse.
4. "Read it with `content: 'frontmatter'` on its path" invited an item-level `content`. It now
   shows the call: `{ paths: [path], content: 'frontmatter' }`.

**Declined.** In `search_notes`, the word "exact" sits next to "word prefix" for the lexical leg.
This is pre-existing wording, inside a spec-governed description at 4,049 of its 4,050-character
cap.

**Known, now in the spec.** A bare-path `preview` of a note whose YAML does not parse returns the
raw prefix but echoes the body span, the outline mode's `lines`. A test pins it. The PR 4 review
found that the preview requirement did not allow it, so the main spec now carves it out.

**After the fixes.** The fixed `read_notes` description is 5,341 characters. The four fixes were
checked against the code, not re-probed.

---

## Overall Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS (the two drift warnings in §4, both non-blocking)
- [ ] ❌ FAIL

Nothing blocks archive. Run `openspec archive structural-reads -y`, then
`openspec validate --all`.
