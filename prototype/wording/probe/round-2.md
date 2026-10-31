# Probe round 2 — revised A, Haiku, 3 runs

Inputs: revised `read-notes.A-full.md` (round-1 fixes), revised `search-notes.addition.md`,
fixtures with the two round-1 bugs fixed, questions 1–17 (16: clipping, 17: call shape).

## Score

All three runs: 17/17. Every round-1 confusion is gone:

- `content` placement — all three keep it next to `paths` and correct Q17.
- frontmatter end — all three compute `lines[0] − 1` instead of inferring it.
- `heading: ""` — no run reads it as contradicting the outline.
- `hidden` — "headings, all depths" in all three.
- clipping — Q16 `[5, 20]` in all three; partial overlap read as a clip, not a miss.

## Left-over confusions, and the last edit

| Confusion | Runs | Edit (not re-probed) |
|---|---|---|
| "silently pick a same-named sibling" reads as contradicting "several blocks → `AMBIGUOUS_MATCH`" | 3/3 | spell the case out: a bare `Notes` matches the first of `Notes` / `Notes[2]` exactly, no error |
| is `Notes[2]` literal input? | 2/3 | "(literally, as the `heading` value)" |
| "list hidden headings with `{ path, heading }`" — whose heading? | 1/3 | "that entry's outline", naming the entry that carries `hidden` |
| bare-path default changes with the item count | 3/3 | none: decided in issue 251; the description states it |

Fixture artefacts (abbreviated prefix, a collapsed log with few visible entries) were flagged
too; they are not wording.
