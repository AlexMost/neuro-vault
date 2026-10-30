# Verification Report

**Change**: `lexical-word-boundary`
**Verified at**: `2026-10-30 10:30`
**Verifier**: Claude Opus 5.5, the session that wrote the change, running from a side session. It ran
the gates, the eval and the scenario mapping itself. A fresh review subagent read the whole diff:
no Critical finding, one Important (fixed in 7fe0669), four Minor (§4).

Scope: branch `claude/lexical-word-boundary-231`, one PR, `Closes #231`.

### Gates

| Gate                                          | Result                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| `npm test`                                    | 2939 passed, 4 skipped (base 2923 passed; +16 tests)    |
| `npm run lint` (`eslint .`)                   | clean                                                   |
| `npm run typecheck` (`tsc --noEmit`)          | clean                                                   |
| `npm run format`                              | clean                                                   |
| `npm run build`                               | success                                                 |
| `npx commitlint --from origin/main --to HEAD` | 0 problems (one `footer-leading-blank` warning, e96c364) |

### Eval (production, `harrier-270m`, owner's vault)

The golden set has 80 entries: 63 answerable and 17 controls. Before is `main` (2b8641d), run from
a temporary checkout; after is 7fe0669. All eight runs used the same vault commit; reports are in
the vault's private repository.

| run                  | hit@3 | MRR   | R@10  | controls returning anything | mean notes on controls |
| -------------------- | ----- | ----- | ----- | --------------------------- | ---------------------- |
| lexical quick before | 0.714 | 0.668 | 0.557 | 5 of 17                     | 1.12                   |
| lexical quick after  | 0.714 | 0.668 | 0.565 | 1 of 17                     | 0.12                   |
| lexical deep before  | 0.714 | 0.668 | 0.636 | 5 of 17                     | 1.41                   |
| lexical deep after   | 0.714 | 0.668 | 0.644 | 1 of 17                     | 0.12                   |
| fused quick before   | 0.937 | 0.836 | 0.676 | 6 of 17                     | 1.29                   |
| fused quick after    | 0.937 | 0.844 | 0.684 | 3 of 17                     | 0.47                   |
| fused deep before    | 0.905 | 0.820 | 0.823 | 6 of 17                     | 2.29                   |
| fused deep after     | 0.905 | 0.828 | 0.830 | 3 of 17                     | 1.53                   |

- **Metric moved as simulated.** `lexical` quick controls 5 → 1 and mean 1.12 → 0.12; `fused` quick
  6 → 3 and 1.29 → 0.47. Both equal the #228 simulation.
- **Guard holds.** `lexical` hit@3 0.714 (floor 0.714) and R@10 0.565 (floor 0.557); fused hit@3
  unchanged at quick and deep.
- Lexical notes returned on controls: 19 → 2 at quick, 21 → 2 in fused deep. What remains on
  fused controls is semantic and expansion.
- The review fix (an opening quote starts a word) did not move any number: the same after-runs
  on an earlier vault commit, before the fix, gave identical results.

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true` — 27 items, 0 invalid.

## 2. Task Completion (`tasks.md`)

- [x] Every task is `- [x]` (9 of 9).

## 3. Delta Spec Sync State

| Capability      | Sync state                         | Note                                                   |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| `hybrid-search` | ✗ Needs sync (done by the archive) | RENAMED + MODIFIED "Matching is normalized … AND"; MODIFIED "Lexical leg matches title, headings, and body blocks" |

## 4. Design / Specs Coherence Spot Check

| Sample                  | Design                                               | Specs                                                                            | Gap  |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| D1 word prefix          | occurrence must start a word; end free               | Matching requirement; "inflected forms match by word prefix", "a token inside a longer word does not match" | none |
| D2 word character       | letter, digit, `_`; `'` only after one               | requirement text; "underscore and apostrophe are inside a word", "an opening quote starts a word" | none |
| D3 punctuation-led      | no boundary needed                                   | "a token led by punctuation needs no boundary"                                   | none |
| D4 drawing payloads     | `compressed-json` produces no unit                   | title/headings/body requirement; "a drawing payload does not match", "a drawing's text elements still match" | none |

Scenario → test mapping: inflection `rank.test.ts` "inflected forms match by word prefix" and
`match.test.ts`; in-word `match.test.ts` "does not match a token inside a longer word" and
`rank.test.ts` "an in-word occurrence is no candidate"; hyphen, underscore, apostrophe, opening
quote and punctuation-led cases in `match.test.ts`; payload `blocks.test.ts` and `rank.test.ts`
"a drawing payload is neither matched nor counted"; per-token counts `rank.test.ts` "counts a
token only where it starts a word"; description `search-notes-description.test.ts`.

**Review findings:**

- Important — fixed (7fe0669): normalization folds curly quotes to `'`, and `'` counted as a word
  character, so a word in single quotes no longer matched. D2, the spec and the docs now make the
  apostrophe a word character only after a letter, digit or `_`.
- Minor — fixed (7fe0669): a lone low surrogate after a letter was read as part of a pair.
- Minor — documented: Excalidraw with compression off stores its scene in a `json` fence, which
  stays a unit (design Risks, `lexical-search.md` §3).
- Minor — kept: some tests are regression pins that also pass on the old code (stem match, AND,
  hyphen, `json` fence). They pin the behaviour that must not change.
- Minor — pre-existing, out of scope: `normalizeWithMap` maps per code point while `firstIndex` is
  in UTF-16 units, so snippet coordinates drift after astral characters (emoji). Not made worse
  by this change; a follow-up.

**Drift warnings** (non-blocking): `brainstorm.md` Q2 and `plan.md` Global Constraints still state
`'` as an unconditional word character, the rule before the review fix. They are left as the
record of what was planned; design D2 is the source of truth.

## 5. Implementation Signal

- [x] No unstaged files in the worktree after the verify commit.
- [ ] Commits pushed — pushed with the PR.

**Commit range**: `2b8641d..HEAD` (e96c364, ed7aaf0, f81a3e6, d94ab9a, 7fe0669, then the close-out
commits).

## 6. Front-Door Routing Leak Detector

- [x] No files in `docs/superpowers/specs/`.

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

N/A — the plan has no deferred manual task. The eval is the end-to-end check and was run.

## Overall Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — the drift warning in §4 (historical artifacts), non-blocking.
- [ ] ❌ FAIL
