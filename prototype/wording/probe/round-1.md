# Probe round 1 — A (full) vs B (lean), Haiku, 3 runs each

Inputs: `read-notes.A-full.md` or `read-notes.B-lean.md`, `search-notes.addition.md`,
`fixtures.md` (round-1 version), `questions.md`. Each run read only those four files.

## Score

| Q | Topic | A1 | A2 | A3 | B1 | B2 | B3 |
|---|---|---|---|---|---|---|---|
| 1 | rung choice (outline) | ✓ | ✓ | ✓ | ✓ | ✗ `content` inside the item | ✓ |
| 2 | per-item default | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 3 | heading read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4 | own text 14–17 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 | `hidden` unit + drill-down | ✓ | ✓ | ✓ | ✓ | ✗ `content` inside the item | ✓ |
| 6 | prefix vs collapsed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 7 | frontmatter end, coords | ✓ inferred | ✓ inferred | ✓ inferred | ✓ inferred | ✓ inferred | ✓ inferred |
| 8 | `heading: ""` → lines | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 9 | lexical hit → lines | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 10 | enclosing block | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 11 | HEADING_NOT_FOUND | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 12 | AMBIGUOUS_MATCH → lines | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 13 | LINES_OUT_OF_RANGE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 14 | no frontmatter on a miss | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 15 | silent mismatch check | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The 247 confusion (`hidden` with no unit) is gone in all six runs. Both 246 confusions stay gone.

## Confusions flagged by the runs

| Confusion | Runs | Fix in round 2 |
|---|---|---|
| Is `content` per item or call-level? | 5/6 flagged, B2 got it wrong | say "one value for the whole call", show it next to `paths` |
| Where does frontmatter end? | 6/6 inferred it | say "frontmatter ends on `lines[0] − 1`" |
| `heading: ""` block sits inside a heading block — contradiction? | 5/6 | say "a paragraph inside a heading block, or the preamble; it does not name the block around it" |
| Does `hidden` count children or all descendants? | 5/6 | "n headings below it, all depths" (as the 246 prototype counts) |
| Partial overlap: clipped or a miss? | 4/6 | "a partial overlap is clipped, not a miss" |
| Exact name matching several blocks? | 3/6 | "a name matching several blocks is `AMBIGUOUS_MATCH`" |
| Fixture 4: why no error? | 5/6 | say a lexical label can pick a same-named sibling silently |
| Heading block extent | B only (2/3) | A defines it; B does not |
| Can a hidden heading be read by name? | 1/6 | "hidden headings are still readable by name" |

Fixture bugs (not wording): `logs/2026.md` body span started on line 4 while its first heading
sat on line 5 with no blank line between; the onboarding prefix was too short for its line
numbers. Both fixed for round 2.

## Verdict

Both variants navigate. A is preferred: B left the heading-block extent undefined, and B2 put
`content` inside an item, which the strict gate would reject. Round 2 tests A with the fixes.
